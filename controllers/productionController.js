const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const FinishedProduct = require("../models/finishedProduct");
const ProductionRecipe = require("../models/productionRecipe");
const ProductionRun = require("../models/productionRun");
const FinishedStockBalance = require("../models/finishedStockBalance");
const FinishedStockMovement = require("../models/finishedStockMovement");
const RawMaterial = require("../models/rawMaterial");
const RawMaterialBalance = require("../models/rawMaterialBalance");
const RawMaterialMovement = require("../models/rawMaterialMovement");
const RawMaterialAlert = require("../models/rawMaterialAlert");
const ProductionMaterialUsage = require("../models/productionMaterialUsage");
const User = require("../models/user");
const audit = require("../lib/audit");
const {
  getFinishedBalance,
  getRawMaterialBalance,
  refreshRawMaterialAlert,
  recordFinishedStockMovement,
  recordRawMaterialMovement,
} = require("../lib/productionInventory");

const PACK_SIZES = ["150 ml", "180 ml", "200 ml", "250 ml", "300 ml", "350 ml", "500 ml"];
const PRODUCT_CATEGORIES = ["Cup", "Bottle"];
const FLAVOURS = ["Mango", "Pineapple milk"];
const MAX_PAGE_SIZE = 200;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validObjectId(value) {
  return typeof value === "string" && mongoose.isValidObjectId(value);
}

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

function requestObject(body, allowed) {
  return body && typeof body === "object" && !Array.isArray(body)
    && !Object.keys(body).some((key) => !allowed.includes(key));
}

function actorId(request) {
  return request.authUser._id;
}

function statusError(response, status, error) {
  return response.status(status).json({ error });
}

function conflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function pageSize(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(MAX_PAGE_SIZE, Math.max(1, parsed)) : 100;
}

function serialize(document) {
  if (!document) return document;
  if (document.toJSON) return document.toJSON();
  const result = { ...document };
  if (result._id !== undefined) {
    result.id = String(result._id);
    delete result._id;
  }
  delete result.__v;
  return result;
}

async function withTransaction(work) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
  } finally {
    await session.endSession();
  }
  return result;
}

function validateProduct(body, partial = false) {
  const allowed = ["code", "name", "category", "unit", "flavour", "packType", "piecesPerPack", "packWeightKg", "price", "recipeRequired", "active", "ingredients"];
  if (!requestObject(body, allowed)) return { error: "Provide product fields in the supported request shape." };
  const product = {};
  for (const field of ["code", "name", "category", "unit", "flavour"]) {
    if (!own(body, field) && partial) continue;
    if (typeof body[field] !== "string" || !body[field].trim()) return { error: `${field} is required.` };
    product[field] = body[field].trim();
  }
  if (product.code && (product.code.length > 40 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(product.code))) {
    return { error: "Product code must be 1–40 letters, numbers, dots, dashes, or underscores." };
  }
  if (product.name && product.name.length > 160) return { error: "Product name must be 160 characters or fewer." };
  if (product.category && !PRODUCT_CATEGORIES.includes(product.category)) return { error: "Choose Cup or Bottle as the product category." };
  if (product.unit && !PACK_SIZES.includes(product.unit)) return { error: "Product unit must be a supported millilitre pack size." };
  if (product.flavour && !FLAVOURS.includes(product.flavour)) return { error: "Choose a supported product flavour." };
  if (own(body, "price") || !partial) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price <= 0) return { error: "Product price must be a positive whole number of UGX per pack." };
    product.price = price;
  }

  const hasPackInput = ["packType", "piecesPerPack", "packWeightKg"].some((field) => own(body, field));
  if (hasPackInput || !partial) {
    const packType = body.packType === "" || body.packType === null ? undefined : body.packType;
    if (packType !== undefined && !["Box", "Carton"].includes(packType)) return { error: "Outer pack type must be Box or Carton." };
    if (packType === undefined) {
      if ((body.piecesPerPack !== undefined && body.piecesPerPack !== "" && body.piecesPerPack !== null)
        || (body.packWeightKg !== undefined && body.packWeightKg !== "" && body.packWeightKg !== null)) {
        return { error: "Choose a box or carton when specifying pack details." };
      }
      product.packType = undefined;
      product.piecesPerPack = undefined;
      product.packWeightKg = undefined;
    } else {
      const pieces = Number(body.piecesPerPack);
      const weight = Number(body.packWeightKg);
      if (!Number.isInteger(pieces) || pieces <= 0) return { error: "Pieces per pack must be a positive whole number." };
      if (!positive(weight)) return { error: "Net product weight per pack must be a positive number of kilograms." };
      product.packType = packType;
      product.piecesPerPack = pieces;
      product.packWeightKg = weight;
    }
  }
  if (own(body, "active")) {
    if (typeof body.active !== "boolean") return { error: "active must be true or false." };
    product.active = body.active;
  }
  if (own(body, "recipeRequired")) {
    if (typeof body.recipeRequired !== "boolean") return { error: "recipeRequired must be true or false." };
    product.recipeRequired = body.recipeRequired;
  }
  if (own(body, "ingredients")) {
    const validation = validateIngredients(body.ingredients, true);
    if (validation.error) return validation;
    product.ingredients = validation.value;
  }
  return { value: product };
}

function validateIngredients(value, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > 100 || (!allowEmpty && value.length < 1)) {
    return { error: "A recipe must contain between 1 and 100 ingredients." };
  }
  const ids = new Set();
  const ingredients = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "Each recipe ingredient must be an object." };
    const allowed = ["materialId", "quantityPerTank"];
    if (Object.keys(item).some((key) => !allowed.includes(key))) return { error: "Recipe ingredient contains unsupported fields." };
    if (!positive(Number(item.quantityPerTank))) return { error: "Ingredient quantity per 1,000-litre tank must be a positive number." };
    if (!validObjectId(item.materialId)) return { error: "Choose an existing shared raw material for every recipe ingredient." };
    const id = String(new mongoose.Types.ObjectId(item.materialId));
    if (ids.has(id)) return { error: "A material can appear only once in a product recipe." };
    ids.add(id);
    ingredients.push({ materialId: id, quantityPerTank: Number(item.quantityPerTank) });
  }
  return { value: ingredients };
}

async function resolveIngredients(ingredients, request, session) {
  const resolved = [];
  for (const ingredient of ingredients) {
    const material = await RawMaterial.findOne({
      _id: ingredient.materialId,
      active: true,
    }).session(session);
    if (!material) {
      const error = new Error("A selected recipe ingredient is missing or inactive.");
      error.statusCode = 400;
      throw error;
    }
    resolved.push({
      materialId: material._id,
      materialName: material.name,
      unit: material.unit,
      quantityPerTank: ingredient.quantityPerTank,
    });
  }
  return resolved;
}

function nextError(error, response) {
  if (error?.statusCode) return statusError(response, error.statusCode, error.message);
  if (error?.code === 11000) return statusError(response, 409, "A record with that code, name, date, or request key already exists.");
  if (error?.name === "ValidationError" || error?.name === "CastError") return statusError(response, 400, error.message);
  throw error;
}

async function listProducts(_request, response) {
  const products = await FinishedProduct.find().sort({ name: 1 }).lean();
  const ids = products.map((product) => product._id);
  const balances = await FinishedStockBalance.find({ productId: { $in: ids } }).lean();
  const balanceMap = new Map(balances.map((balance) => [String(balance.productId), balance]));
  const recipes = await ProductionRecipe.find({
    _id: { $in: products.map((product) => product.activeRecipeId).filter(Boolean) },
  }).lean();
  const recipeMap = new Map(recipes.map((recipe) => [String(recipe._id), recipe]));
  return response.json({
    products: products.map((product) => ({
      ...serialize(product),
      balancePieces: balanceMap.get(String(product._id))?.quantityPieces ?? 0,
      reservedPieces: balanceMap.get(String(product._id))?.reservedPieces ?? 0,
      availablePieces: Math.max(0, (balanceMap.get(String(product._id))?.quantityPieces ?? 0) - (balanceMap.get(String(product._id))?.reservedPieces ?? 0)),
      recipe: recipeMap.has(String(product.activeRecipeId)) ? serialize(recipeMap.get(String(product.activeRecipeId))) : null,
    })),
  });
}

async function createProduct(request, response) {
  const { value, error } = validateProduct(request.body);
  if (error) return statusError(response, 400, error);
  if (value.recipeRequired && !value.ingredients?.length) {
    return statusError(response, 400, "Add at least one ingredient to a recipe-required product.");
  }
  try {
    const result = await withTransaction(async (session) => {
      const ingredients = value.ingredients;
      delete value.ingredients;
      const [product] = await FinishedProduct.create([{
        ...value,
        createdBy: actorId(request),
        updatedBy: actorId(request),
      }], { session });
      await FinishedStockBalance.create([{
        productId: product._id,
        quantityPieces: 0,
        updatedBy: actorId(request),
      }], { session });
      let recipe = null;
      if (ingredients?.length) {
        const resolved = await resolveIngredients(ingredients, request, session);
        [recipe] = await ProductionRecipe.create([{
          productId: product._id,
          version: 1,
          ingredients: resolved,
          createdBy: actorId(request),
        }], { session });
        product.activeRecipeId = recipe._id;
        await product.save({ session });
      }
      await audit.recordAudit({
        request,
        eventType: "production.product_created",
        outcome: "success",
        details: { productId: String(product._id), code: product.code, name: product.name, recipeVersion: recipe?.version },
        transaction: session,
      });
      return { product: { ...serialize(product), balancePieces: 0, recipe: recipe ? serialize(recipe) : null } };
    });
    return response.status(201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

async function updateProduct(request, response) {
  if (!validObjectId(request.params.id)) return statusError(response, 400, "Product ID is invalid.");
  const { value, error } = validateProduct(request.body, true);
  if (error) return statusError(response, 400, error);
  if (!Object.keys(value).length) return statusError(response, 400, "Provide at least one supported product field.");
  try {
    const product = await withTransaction(async (session) => {
      const record = await FinishedProduct.findById(request.params.id).session(session);
      if (!record) {
        const missing = new Error("Product not found.");
        missing.statusCode = 404;
        throw missing;
      }
      let recipe;
      if (own(value, "ingredients") && value.ingredients.length) {
        const latest = record.activeRecipeId
          ? await ProductionRecipe.findById(record.activeRecipeId).session(session)
          : null;
        const ingredients = await resolveIngredients(value.ingredients, request, session);
        [recipe] = await ProductionRecipe.create([{
          productId: record._id,
          version: (latest?.version ?? 0) + 1,
          ingredients,
          createdBy: actorId(request),
        }], { session });
        record.activeRecipeId = recipe._id;
      } else if (own(value, "ingredients") && !value.ingredients.length) {
        record.activeRecipeId = null;
      }
      if ((value.recipeRequired ?? record.recipeRequired) && !record.activeRecipeId) {
        const missingRecipe = new Error("Add a recipe before requiring one for production.");
        missingRecipe.statusCode = 400;
        throw missingRecipe;
      }
      const unitChanged = value.unit && value.unit !== record.unit;
      if (unitChanged) {
        const [balance, hasRuns] = await Promise.all([
          FinishedStockBalance.findOne({ productId: record._id }).session(session).lean(),
          ProductionRun.exists({ productId: record._id }).session(session),
        ]);
        if ((balance?.quantityPieces ?? 0) > 0 || hasRuns) {
          const immutableUnit = new Error("The product's sellable unit cannot change after stock or production history exists.");
          immutableUnit.statusCode = 409;
          throw immutableUnit;
        }
      }
      Object.assign(record, value, { updatedBy: actorId(request) });
      await record.save({ session });
      await audit.recordAudit({
        request,
        eventType: value.active === false ? "production.product_deactivated" : "production.product_updated",
        outcome: "success",
        details: { productId: String(record._id), changedFields: Object.keys(value), recipeVersion: recipe?.version },
        transaction: session,
      });
      if (recipe) {
        await audit.recordAudit({
          request,
          eventType: "production.recipe_updated",
          outcome: "success",
          details: { productId: String(record._id), recipeId: String(recipe._id), version: recipe.version, ingredientCount: recipe.ingredients.length },
          transaction: session,
        });
      }
      return record;
    });
    return response.json({ product: serialize(product) });
  } catch (error) {
    return nextError(error, response);
  }
}

async function listMaterials(_request, response) {
  const materials = await RawMaterial.find().sort({ name: 1 }).lean();
  const balances = await RawMaterialBalance.find({
    materialId: { $in: materials.map((material) => material._id) },
  }).sort({ location: 1 }).lean();
  const userIds = [...new Set(balances.map((balance) => String(balance.responsibleUserId)).filter((id) => id !== "null"))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select("name email roles status").lean() : [];
  const userMap = new Map(users.map((user) => [String(user._id), user]));
  const balanceMap = new Map();
  for (const balance of balances) {
    const key = String(balance.materialId);
    const responsibleUser = balance.responsibleUserId ? userMap.get(String(balance.responsibleUserId)) : null;
    const location = {
      id: String(balance._id),
      location: balance.location || "Main Warehouse",
      quantity: balance.quantity,
      reorderThreshold: balance.reorderThreshold ?? 0,
      responsibleUserId: balance.responsibleUserId ? String(balance.responsibleUserId) : null,
      responsibleUserName: responsibleUser?.name ?? null,
      responsibleUserActive: responsibleUser?.status === "Active",
    };
    balanceMap.set(key, [...(balanceMap.get(key) ?? []), location]);
  }
  return response.json({
    materials: materials.map((material) => {
      const locations = balanceMap.get(String(material._id)) ?? [];
      return {
        ...serialize(material),
        locations,
        balance: locations.reduce((total, item) => total + item.quantity, 0),
      };
    }),
  });
}

async function createMaterial(request, response) {
  if (!requestObject(request.body, ["code", "name", "category", "unit"])
    || typeof request.body.code !== "string" || typeof request.body.name !== "string"
    || typeof request.body.unit !== "string"
    || (request.body.category !== undefined && typeof request.body.category !== "string")) {
    return statusError(response, 400, "Provide material code, name, category, and unit.");
  }
  const code = request.body.code.trim();
  const name = request.body.name.trim();
  const category = String(request.body.category || "General").trim();
  const unit = request.body.unit.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(code) || !name || name.length > 160
    || !category || category.length > 80 || !unit || unit.length > 24) {
    return statusError(response, 400, "Material code, name, category, and unit are invalid.");
  }
  try {
    const result = await withTransaction(async (session) => {
      const [material] = await RawMaterial.create([{
        code,
        name,
        category,
        unit,
        createdBy: actorId(request),
        updatedBy: actorId(request),
      }], { session });
      await RawMaterialBalance.create([{
        materialId: material._id,
        location: "Main Warehouse",
        quantity: 0,
        updatedBy: actorId(request),
      }], { session });
      await audit.recordAudit({
        request,
        eventType: "production.material_created",
        outcome: "success",
        details: { materialId: String(material._id), code, name, category, unit },
        transaction: session,
      });
      return { material: { ...serialize(material), balance: 0, locations: [{ location: "Main Warehouse", quantity: 0, reorderThreshold: 0 }] } };
    });
    return response.status(201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

async function changeRecipe(request, response) {
  if (!validObjectId(request.params.id)) return statusError(response, 400, "Product ID is invalid.");
  if (!requestObject(request.body, ["ingredients"])) return statusError(response, 400, "Provide recipe ingredients.");
  const { value, error } = validateIngredients(request.body.ingredients, true);
  if (error) return statusError(response, 400, error);
  try {
    const result = await withTransaction(async (session) => {
      const product = await FinishedProduct.findById(request.params.id).session(session);
      if (!product) {
        const missing = new Error("Product not found.");
        missing.statusCode = 404;
        throw missing;
      }
      const latest = product.activeRecipeId
        ? await ProductionRecipe.findById(product.activeRecipeId).session(session)
        : null;
      if (!value.length && product.recipeRequired) {
        const required = new Error("A recipe-required product must keep at least one recipe ingredient.");
        required.statusCode = 400;
        throw required;
      }
      const ingredients = value.length ? await resolveIngredients(value, request, session) : [];
      let recipe = null;
      if (ingredients.length) {
        [recipe] = await ProductionRecipe.create([{
          productId: product._id,
          version: (latest?.version ?? 0) + 1,
          ingredients,
          createdBy: actorId(request),
        }], { session });
      }
      product.activeRecipeId = recipe?._id ?? null;
      product.updatedBy = actorId(request);
      await product.save({ session });
      await audit.recordAudit({
        request,
        eventType: "production.recipe_updated",
        outcome: "success",
        details: { productId: String(product._id), recipeId: recipe ? String(recipe._id) : undefined, version: recipe?.version, ingredientCount: ingredients.length },
        transaction: session,
      });
      return { recipe: recipe ? serialize(recipe) : null };
    });
    return response.status(201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

async function receiveRawMaterial(request, response) {
  const { materialId } = request.params;
  const { quantity, date, reference, reason, idempotencyKey, location, supplier, sourceReference, unitCost } = request.body || {};
  if (!requestObject(request.body, ["quantity", "date", "reference", "reason", "idempotencyKey", "location", "supplier", "sourceReference", "unitCost"])) {
    return statusError(response, 400, "Receipt contains unsupported fields.");
  }
  if (!validObjectId(materialId) || !positive(Number(quantity)) || !validDate(date)
    || typeof reason !== "string" || !reason.trim() || reason.trim().length > 300) {
    return statusError(response, 400, "Provide a valid material, positive quantity, date, and receipt reason.");
  }
  const destination = typeof location === "string" && location.trim() ? location.trim() : "Main Warehouse";
  if (destination.length > 100 || (supplier !== undefined && (typeof supplier !== "string" || supplier.trim().length > 160))
    || (sourceReference !== undefined && (typeof sourceReference !== "string" || sourceReference.trim().length > 120))
    || (unitCost !== undefined && (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0))) {
    return statusError(response, 400, "Location, supplier, source reference, or unit cost is invalid.");
  }
  if (reference !== undefined && (typeof reference !== "string" || reference.trim().length > 80)) {
    return statusError(response, 400, "Reference must be 80 characters or fewer.");
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 120)) {
    return statusError(response, 400, "Idempotency key must be 1–120 characters.");
  }
  try {
    const result = await withTransaction(async (session) => {
      if (idempotencyKey) {
        const existing = await RawMaterialMovement.findOne({ idempotencyKey }).session(session).lean();
        if (existing) {
          const sameRequest = String(existing.materialId) === materialId
            && ["Receipt", "Stock in"].includes(existing.type)
            && existing.quantity === Number(quantity)
            && existing.date === date
            && existing.reason === reason.trim()
            && (existing.toLocation || "Main Warehouse") === destination;
          if (!sameRequest) throw conflictError("Idempotency key was already used for a different raw-material request.");
          return { movement: serialize(existing), balance: await getRawMaterialBalance(materialId, session, destination) };
        }
      }
      const material = await RawMaterial.findOne({ _id: materialId, active: true }).session(session);
      if (!material) {
        const missing = new Error("Material not found or inactive.");
        missing.statusCode = 404;
        throw missing;
      }
      const amount = Number(quantity);
      const movement = await recordRawMaterialMovement({
        materialId: material._id,
        type: "Stock in",
        direction: "in",
        quantity: amount,
        date,
        reference: reference?.trim() || `RM-${randomUUID()}`,
        receiptReference: reference?.trim() || undefined,
        sourceType: "receipt",
        idempotencyKey,
        reason: reason.trim(),
        toLocation: destination,
        supplier: supplier?.trim() || undefined,
        sourceReference: sourceReference?.trim() || undefined,
        unitCost: unitCost === undefined ? undefined : Number(unitCost),
        materialName: material.name,
        unit: material.unit,
        actor: actorId(request),
      }, session);
      await audit.recordAudit({
        request,
        eventType: "inventory.raw_material_received",
        outcome: "success",
        details: { materialId: String(material._id), location: destination, quantity: amount, unit: material.unit, movementId: String(movement._id) },
        transaction: session,
      });
      return { movement: serialize(movement), balance: await getRawMaterialBalance(material._id, session, destination) };
    });
    return response.status(201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

  async function configureMaterialLocation(request, response) {
    const { materialId, location: locationParam } = request.params;
    const location = String(locationParam || "").trim();
    const body = request.body || {};
    if (!validObjectId(materialId) || !location || location.length > 100
      || !requestObject(body, ["reorderThreshold", "responsibleUserId"])
      || !own(body, "reorderThreshold") || !Number.isFinite(Number(body.reorderThreshold)) || Number(body.reorderThreshold) < 0
      || (body.responsibleUserId !== null && body.responsibleUserId !== undefined && !validObjectId(body.responsibleUserId))) {
      return statusError(response, 400, "Provide a valid location, non-negative reorder threshold, and optional responsible user.");
    }
    try {
      const result = await withTransaction(async (session) => {
        const material = await RawMaterial.findOne({ _id: materialId, active: true }).session(session);
        if (!material) {
          const missing = new Error("Material not found or inactive.");
          missing.statusCode = 404;
          throw missing;
        }
        let responsibleUser = null;
        if (body.responsibleUserId) {
          responsibleUser = await User.findOne({
            _id: body.responsibleUserId,
            status: "Active",
            roles: { $in: ["Inventory Manager", "Production Manager", "Admin", "Super Admin"] },
          }).session(session);
          if (!responsibleUser) {
            const invalidOwner = new Error("Responsible user must be an active inventory-capable account.");
            invalidOwner.statusCode = 400;
            throw invalidOwner;
          }
        }
        const balance = await RawMaterialBalance.findOneAndUpdate(
          { materialId: material._id, location },
          {
            $set: {
              reorderThreshold: Number(body.reorderThreshold),
              responsibleUserId: responsibleUser?._id ?? null,
              updatedBy: actorId(request),
            },
            $setOnInsert: { quantity: 0 },
          },
          { upsert: true, new: true, session, setDefaultsOnInsert: true },
        );
        await refreshRawMaterialAlert(material._id, location, session);
        await audit.recordAudit({
          request,
          eventType: "inventory.raw_material_location_configured",
          outcome: "success",
          details: {
            materialId: String(material._id),
            location,
            reorderThreshold: balance.reorderThreshold,
            responsibleUserId: responsibleUser ? String(responsibleUser._id) : null,
          },
          transaction: session,
        });
        return { location: serialize(balance), responsibleUser: responsibleUser ? { id: String(responsibleUser._id), name: responsibleUser.name } : null };
      });
      return response.json(result);
    } catch (error) {
      return nextError(error, response);
    }
  }

  async function listLowStockAlerts(request, response) {
    const filter = { status: "active" };
    if (request.query.location) filter.location = String(request.query.location).trim();
    if (request.query.materialId) {
      if (!validObjectId(request.query.materialId)) return statusError(response, 400, "materialId is invalid.");
      filter.materialId = request.query.materialId;
    }
    if (request.query.recipient === "me") filter.recipientUserId = actorId(request);
    const alerts = await RawMaterialAlert.find(filter)
      .populate("materialId", "code name unit category")
      .populate("recipientUserId", "name email roles")
      .sort({ updatedAt: -1 })
      .limit(pageSize(request.query.limit))
      .lean();
    return response.json({ alerts: alerts.map(serialize) });
  }

  async function listMaterialReceipts(request, response) {
    const filter = { type: "Stock in" };
    if (request.query.materialId) {
      if (!validObjectId(request.query.materialId)) return statusError(response, 400, "materialId is invalid.");
      filter.materialId = request.query.materialId;
    }
    if (request.query.location) filter.toLocation = String(request.query.location).trim();
    if ((request.query.from && !validDate(request.query.from)) || (request.query.to && !validDate(request.query.to))) {
      return statusError(response, 400, "Receipt date filters must be valid YYYY-MM-DD dates.");
    }
    if (request.query.from || request.query.to) {
      filter.date = {};
      if (request.query.from) filter.date.$gte = request.query.from;
      if (request.query.to) filter.date.$lte = request.query.to;
    }
    const movements = await RawMaterialMovement.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .limit(pageSize(request.query.limit))
      .lean();
    return response.json({ movements: movements.map(serialize) });
  }

  async function postRawMovement(request, response, operation) {
    const body = request.body || {};
    const allowed = operation === "transfer"
      ? ["materialId", "fromLocation", "toLocation", "quantity", "date", "reference", "reason", "idempotencyKey"]
      : ["materialId", "location", "direction", "quantity", "date", "reference", "reason", "idempotencyKey"];
    if (!requestObject(body, allowed)) return statusError(response, 400, "Movement contains unsupported fields.");
    const materialId = body.materialId;
    const quantity = Number(body.quantity);
    const date = body.date;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const fromLocation = operation === "transfer" ? String(body.fromLocation || "").trim() : String(body.location || "").trim();
    const toLocation = operation === "transfer" ? String(body.toLocation || "").trim() : "";
    if (!validObjectId(materialId) || !positive(quantity) || !validDate(date) || !reason || reason.length > 300
      || !fromLocation || fromLocation.length > 100
      || (operation === "transfer" && (!toLocation || toLocation.length > 100 || fromLocation === toLocation))) {
      return statusError(response, 400, "Provide a valid material, quantity, date, reason, and stock location.");
    }
    if (body.reference !== undefined && (typeof body.reference !== "string" || body.reference.trim().length > 80)) {
      return statusError(response, 400, "Reference must be 80 characters or fewer.");
    }
    if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 120)) {
      return statusError(response, 400, "Idempotency key must be 1–120 characters.");
    }
    const direction = operation === "transfer" ? "transfer" : body.direction;
    if (operation === "adjustment" && !["in", "out"].includes(direction)) {
      return statusError(response, 400, "Adjustment direction must be in or out.");
    }
    try {
      const result = await withTransaction(async (session) => {
        if (body.idempotencyKey) {
          const existing = await RawMaterialMovement.findOne({ idempotencyKey: body.idempotencyKey }).session(session).lean();
          if (existing) {
            const sameRequest = String(existing.materialId) === materialId
              && existing.direction === direction
              && existing.quantity === quantity
              && existing.date === date
              && (existing.fromLocation || "") === (operation === "transfer" || direction === "out" ? fromLocation : "")
              && (existing.toLocation || "") === (operation === "transfer" ? toLocation : "")
              && existing.reason === reason;
            if (!sameRequest) throw conflictError("Idempotency key was already used for a different inventory movement.");
            return { movement: serialize(existing), balance: await getRawMaterialBalance(materialId, session, fromLocation) };
          }
        }
        const material = await RawMaterial.findOne({ _id: materialId, active: true }).session(session);
        if (!material) {
          const missing = new Error("Material not found or inactive.");
          missing.statusCode = 404;
          throw missing;
        }
        const type = operation === "transfer"
          ? "Transfer"
          : direction === "in" ? "Adjustment increase" : "Adjustment decrease";
        const movement = await recordRawMaterialMovement({
          materialId: material._id,
          type,
          direction,
          quantity,
          date,
          reference: body.reference?.trim() || `RM-${randomUUID()}`,
          sourceType: operation,
          idempotencyKey: body.idempotencyKey,
          reason,
          fromLocation: direction === "out" || operation === "transfer" ? fromLocation : undefined,
          toLocation: direction === "in" || operation === "transfer" ? (operation === "transfer" ? toLocation : fromLocation) : undefined,
          materialName: material.name,
          unit: material.unit,
          actor: actorId(request),
        }, session);
        await audit.recordAudit({
          request,
          eventType: operation === "transfer" ? "inventory.raw_material_transferred" : "inventory.raw_material_adjusted",
          outcome: "success",
          details: { materialId: String(material._id), movementId: String(movement._id), quantity, unit: material.unit, fromLocation, toLocation: toLocation || undefined },
          transaction: session,
        });
        return { movement: serialize(movement), balance: await getRawMaterialBalance(material._id, session, fromLocation) };
      });
      return response.status(201).json(result);
    } catch (error) {
      return nextError(error, response);
    }
  }

  async function adjustRawMaterial(request, response) {
    return postRawMovement(request, response, "adjustment");
  }

  async function transferRawMaterial(request, response) {
    return postRawMovement(request, response, "transfer");
  }

function validateProductionUsageInput(body) {
  if (!requestObject(body, ["productionRunId", "tanksProduced", "location", "idempotencyKey"])) {
    return { error: "Production usage contains unsupported fields." };
  }
  if (!validObjectId(body.productionRunId) || !positive(Number(body.tanksProduced))
    || typeof body.location !== "string" || !body.location.trim() || body.location.trim().length > 100) {
    return { error: "Provide a valid production run, positive tank count, and stock location." };
  }
  if (body.idempotencyKey !== undefined
    && (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 120)) {
    return { error: "Idempotency key must be 1–120 characters." };
  }
  return {
    value: {
      productionRunId: body.productionRunId,
      tanksProduced: Number(body.tanksProduced),
      location: body.location.trim(),
      idempotencyKey: body.idempotencyKey?.trim(),
    },
  };
}

function calculateProductionMaterialLines(ingredients, tanksProduced) {
  return ingredients.map((ingredient) => ({
    materialId: ingredient.materialId,
    materialName: ingredient.materialName,
    unit: ingredient.unit,
    quantityPerTank: ingredient.quantityPerTank,
    totalQuantity: ingredient.quantityPerTank * tanksProduced,
  }));
}

async function postProductionMaterialUsage(request, response) {
  const { value, error } = validateProductionUsageInput(request.body);
  if (error) return statusError(response, 400, error);
  try {
    const result = await withTransaction(async (session) => {
      if (value.idempotencyKey) {
        const existing = await ProductionMaterialUsage.findOne({ idempotencyKey: value.idempotencyKey }).session(session).lean();
        if (existing) {
          const sameRequest = String(existing.productionRunId) === value.productionRunId
            && existing.tanksProduced === value.tanksProduced
            && existing.location === value.location;
          if (!sameRequest) throw conflictError("Idempotency key was already used for a different production-usage request.");
          return { usage: serialize(existing), replayed: true };
        }
      }
      const run = await ProductionRun.findById(value.productionRunId).session(session);
      if (!run) {
        const missing = new Error("Post the finished-goods production run before recording its raw-material use.");
        missing.statusCode = 404;
        throw missing;
      }
      const existingUsage = await ProductionMaterialUsage.findOne({ productionRunId: run._id }).session(session).lean();
      if (existingUsage) throw conflictError("Raw-material usage has already been recorded for this production run.");
      if (value.location.length > 100) {
        const invalidLocation = new Error("Location must be 100 characters or fewer.");
        invalidLocation.statusCode = 400;
        throw invalidLocation;
      }
      const product = await FinishedProduct.findOne({ _id: run.productId, active: true }).session(session);
      if (!product) {
        const missing = new Error("The production run product is missing or inactive.");
        missing.statusCode = 409;
        throw missing;
      }
      if (!run.recipeId) {
        const missingRecipe = new Error("The production run has no recipe snapshot. Save a per-tank product recipe before recording use.");
        missingRecipe.statusCode = 409;
        throw missingRecipe;
      }
      const recipe = await ProductionRecipe.findById(run.recipeId).session(session).lean();
      if (!recipe || recipe.tankVolumeLitres !== 1000 || !recipe.ingredients.length) {
        const missingRecipe = new Error("The production run recipe is missing or does not use the 1,000-litre tank basis.");
        missingRecipe.statusCode = 409;
        throw missingRecipe;
      }
      const lines = [];
      for (const ingredient of recipe.ingredients) {
        const material = await RawMaterial.findOne({ _id: ingredient.materialId, active: true }).session(session);
        if (!material || material.name !== ingredient.materialName || material.unit !== ingredient.unit) {
          const invalidRecipe = new Error("A recipe ingredient is missing or inactive. Update the product recipe before recording use.");
          invalidRecipe.statusCode = 409;
          throw invalidRecipe;
        }
        const locationBalance = await RawMaterialBalance.findOne({
          materialId: material._id,
          location: value.location,
        }).session(session).lean();
        if (!locationBalance) {
          const invalidLocation = new Error(`${material.name} has no inventory configured at ${value.location}.`);
          invalidLocation.statusCode = 409;
          throw invalidLocation;
        }
        const latestMovement = await RawMaterialMovement.findOne({
          materialId: material._id,
          $or: [
            { fromLocation: value.location },
            { toLocation: value.location },
            { fromLocation: { $exists: false }, toLocation: { $exists: false } },
          ],
        }).sort({ date: -1, createdAt: -1 }).session(session).lean();
        if (latestMovement && latestMovement.date > run.productionDate) {
          throw conflictError(`Production date is earlier than the latest stock movement for ${material.name} at ${value.location}.`);
        }
        lines.push({
          materialId: material._id,
          materialName: material.name,
          unit: material.unit,
          quantityPerTank: ingredient.quantityPerTank,
        });
      }
      const usageLines = calculateProductionMaterialLines(lines, value.tanksProduced);
      const reference = `USE-${randomUUID()}`;
      const [usage] = await ProductionMaterialUsage.create([{
        reference,
        productionRunId: run._id,
        productId: run.productId,
        productName: run.productName,
        productionDate: run.productionDate,
        tanksProduced: value.tanksProduced,
        tankVolumeLitres: 1000,
        location: value.location,
        recipeId: recipe._id,
        recipeVersion: recipe.version,
        lines: usageLines,
        idempotencyKey: value.idempotencyKey,
        actor: actorId(request),
      }], { session });
      for (const line of usageLines) {
        await recordRawMaterialMovement({
          materialId: line.materialId,
          type: "Production use",
          direction: "out",
          quantity: line.totalQuantity,
          date: run.productionDate,
          reference,
          sourceType: "production-usage",
          sourceId: usage._id,
          reason: `${value.tanksProduced} × 1,000-litre tanks of ${run.productName}`,
          fromLocation: value.location,
          materialName: line.materialName,
          unit: line.unit,
          actor: actorId(request),
        }, session);
      }
      await audit.recordAudit({
        request,
        eventType: "inventory.production_materials_used",
        outcome: "success",
        details: {
          productionUsageId: String(usage._id),
          productionRunId: String(run._id),
          reference,
          productId: String(run.productId),
          tanksProduced: value.tanksProduced,
          tankVolumeLitres: 1000,
          ingredientCount: lines.length,
        },
        transaction: session,
      });
      return { usage: serialize(usage), replayed: false };
    });
    return response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

async function listProductionMaterialUsages(request, response) {
  const filter = {};
  if (request.query.productId) {
    if (!validObjectId(request.query.productId)) return statusError(response, 400, "productId is invalid.");
    filter.productId = request.query.productId;
  }
  if (request.query.productionRunId) {
    if (!validObjectId(request.query.productionRunId)) return statusError(response, 400, "productionRunId is invalid.");
    filter.productionRunId = request.query.productionRunId;
  }
  if ((request.query.from && !validDate(request.query.from)) || (request.query.to && !validDate(request.query.to))) {
    return statusError(response, 400, "Production-use date filters must be valid YYYY-MM-DD dates.");
  }
  if (request.query.from || request.query.to) {
    filter.productionDate = {};
    if (request.query.from) filter.productionDate.$gte = request.query.from;
    if (request.query.to) filter.productionDate.$lte = request.query.to;
  }
  const usages = await ProductionMaterialUsage.find(filter)
    .sort({ productionDate: -1, createdAt: -1 })
    .limit(pageSize(request.query.limit))
    .lean();
  return response.json({ usages: usages.map(serialize) });
}

async function receiveFinishedStock(request, response) {
  return postFinishedMovement(request, response, "in");
}

async function adjustFinishedStock(request, response) {
  const { direction } = request.body || {};
  if (!["in", "out"].includes(direction)) return statusError(response, 400, "Adjustment direction must be in or out.");
  return postFinishedMovement(request, response, direction, true);
}

async function postFinishedMovement(request, response, direction, adjustment = false) {
  const allowed = adjustment
    ? ["productId", "direction", "quantityPieces", "date", "reason", "reference", "idempotencyKey"]
    : ["productId", "quantityPieces", "date", "reason", "reference", "idempotencyKey"];
  if (!requestObject(request.body, allowed)) return statusError(response, 400, "Movement contains unsupported fields.");
  const { productId, quantityPieces, date, reason, reference, idempotencyKey } = request.body;
  if (!validObjectId(productId) || !Number.isInteger(Number(quantityPieces)) || Number(quantityPieces) <= 0 || !validDate(date)
    || typeof reason !== "string" || !reason.trim() || reason.trim().length > 300) {
    return statusError(response, 400, "Provide a valid product, positive quantity, date, and reason.");
  }
  if (reference !== undefined && (typeof reference !== "string" || reference.trim().length > 80)) {
    return statusError(response, 400, "Reference must be 80 characters or fewer.");
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 120)) {
    return statusError(response, 400, "Idempotency key must be 1–120 characters.");
  }
  try {
    const result = await withTransaction(async (session) => {
      if (idempotencyKey) {
        const existing = await FinishedStockMovement.findOne({ idempotencyKey }).session(session).lean();
        if (existing) {
          const expectedType = adjustment
            ? direction === "in" ? "Adjustment increase" : "Adjustment decrease"
            : "Other stock in";
          const sameRequest = String(existing.productId) === productId
            && existing.direction === direction
            && existing.type === expectedType
            && existing.quantityPieces === Number(quantityPieces)
            && existing.date === date
            && existing.reason === reason.trim();
          if (!sameRequest) throw conflictError("Idempotency key was already used for a different finished-stock request.");
          return { movement: serialize(existing), balancePieces: await getFinishedBalance(productId, session) };
        }
      }
      const product = await FinishedProduct.findOne({ _id: productId, active: true }).session(session);
      if (!product) {
        const missing = new Error("Product not found or inactive.");
        missing.statusCode = 404;
        throw missing;
      }
      const amount = Number(quantityPieces);
      const type = adjustment
        ? direction === "in" ? "Adjustment increase" : "Adjustment decrease"
        : "Other stock in";
      const movement = await recordFinishedStockMovement({
        productId: product._id,
        type,
        direction,
        quantityPieces: amount,
        date,
        reference: reference?.trim() || `FG-${randomUUID()}`,
        sourceType: adjustment ? "adjustment" : "receipt",
        idempotencyKey,
        reason: reason.trim(),
        productName: product.name,
        actor: actorId(request),
      }, session);
      await audit.recordAudit({
        request,
        eventType: adjustment ? "production.finished_stock_adjusted" : "production.finished_stock_received",
        outcome: "success",
        details: { productId: String(product._id), quantityPieces: amount, direction, movementId: String(movement._id), reason: reason.trim() },
        transaction: session,
      });
      return { movement: serialize(movement), balancePieces: await getFinishedBalance(product._id, session) };
    });
    return response.status(201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

async function listFinishedMovements(request, response) {
  const filter = {};
  if (request.query.productId) {
    if (!validObjectId(request.query.productId)) return statusError(response, 400, "productId is invalid.");
    filter.productId = request.query.productId;
  }
  if (request.query.from || request.query.to) {
    if ((request.query.from && !validDate(request.query.from)) || (request.query.to && !validDate(request.query.to))) {
      return statusError(response, 400, "Movement date filters must be valid YYYY-MM-DD dates.");
    }
    filter.date = {};
    if (request.query.from) filter.date.$gte = request.query.from;
    if (request.query.to) filter.date.$lte = request.query.to;
  }
  const limit = pageSize(request.query.limit);
  const movements = await FinishedStockMovement.find(filter).sort({ date: -1, createdAt: -1 }).limit(limit).lean();
  return response.json({ movements: movements.map(serialize) });
}

async function listRawMovements(request, response) {
  const filter = {};
  if (request.query.materialId) {
    if (!validObjectId(request.query.materialId)) return statusError(response, 400, "materialId is invalid.");
    filter.materialId = request.query.materialId;
  }
  if (request.query.location) {
    const location = String(request.query.location).trim();
    filter.$or = [{ fromLocation: location }, { toLocation: location }];
  }
  if (request.query.type) filter.type = String(request.query.type);
  if ((request.query.from && !validDate(request.query.from)) || (request.query.to && !validDate(request.query.to))) {
    return statusError(response, 400, "Movement date filters must be valid YYYY-MM-DD dates.");
  }
  if (request.query.from || request.query.to) {
    filter.date = {};
    if (request.query.from) filter.date.$gte = request.query.from;
    if (request.query.to) filter.date.$lte = request.query.to;
  }
  const limit = pageSize(request.query.limit);
  const movements = await RawMaterialMovement.find(filter).sort({ date: -1, createdAt: -1 }).limit(limit).lean();
  return response.json({ movements: movements.map(serialize) });
}

async function listInventoryResponsibleUsers(_request, response) {
  const users = await User.find({
    status: "Active",
    roles: { $in: ["Inventory Manager", "Production Manager", "Admin", "Super Admin"] },
  }).select("name email roles").sort({ name: 1 }).lean();
  return response.json({
    users: users.map((user) => ({
      id: String(user._id),
      name: user.name,
      email: user.email,
      roles: user.roles,
    })),
  });
}

async function listProductionRuns(request, response) {
  const filter = {};
  for (const field of ["productId", "from", "to"]) {
    if (request.query[field] && field === "productId") {
      if (!validObjectId(request.query[field])) return statusError(response, 400, "productId is invalid.");
      filter.productId = request.query.productId;
    }
  }
  if (request.query.from || request.query.to) {
    if ((request.query.from && !validDate(request.query.from)) || (request.query.to && !validDate(request.query.to))) {
      return statusError(response, 400, "Production date filters must be valid YYYY-MM-DD dates.");
    }
    filter.productionDate = {};
    if (request.query.from) filter.productionDate.$gte = request.query.from;
    if (request.query.to) filter.productionDate.$lte = request.query.to;
  }
  const limit = pageSize(request.query.limit);
  const runs = await ProductionRun.find(filter).sort({ productionDate: -1, createdAt: -1 }).limit(limit).lean();
  return response.json({ runs: runs.map(serialize) });
}

function validateProductionInput(body) {
  const allowed = ["productId", "productionDate", "openingStockPieces", "salesQuantityPieces", "damagedQuantityPieces", "closingStockPieces", "damageReason", "idempotencyKey"];
  if (!requestObject(body, allowed)) return { error: "Production record contains unsupported fields." };
  if (!validObjectId(body.productId)) return { error: "Choose a valid product." };
  if (!validDate(body.productionDate)) return { error: "Production date must be a valid YYYY-MM-DD date." };
  for (const field of ["openingStockPieces", "damagedQuantityPieces", "closingStockPieces"]) {
    if (!Number.isInteger(Number(body[field])) || Number(body[field]) < 0) return { error: `${field} must be a non-negative whole number of pieces.` };
  }
  if (Number(body.damagedQuantityPieces) > 0 && (typeof body.damageReason !== "string" || !body.damageReason.trim())) {
    return { error: "A damage reason is required when damaged quantity is greater than zero." };
  }
  if (body.damageReason !== undefined && (typeof body.damageReason !== "string" || body.damageReason.trim().length > 300)) {
    return { error: "Damage reason must be 300 characters or fewer." };
  }
  if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 120)) {
    return { error: "Idempotency key must be 1–120 characters." };
  }
  const salesQuantityPieces = body.salesQuantityPieces === undefined ? 0 : Number(body.salesQuantityPieces);
  if (!Number.isInteger(salesQuantityPieces) || salesQuantityPieces < 0) {
    return { error: "salesQuantityPieces must be a non-negative whole number of pieces." };
  }
  if (salesQuantityPieces > 0) {
    return { error: "Sales dispatches must be recorded through the Sales feature." };
  }
  const produced = Number(body.closingStockPieces)
    + Number(body.damagedQuantityPieces) - Number(body.openingStockPieces);
  if (produced < 0) return { error: "Calculated production cannot be negative." };
  return { value: { ...body, salesQuantityPieces: 0, producedQuantityPieces: produced } };
}

async function createProductionRun(request, response) {
  const { value, error } = validateProductionInput(request.body);
  if (error) return statusError(response, 400, error);
  try {
    const result = await withTransaction(async (session) => {
      if (value.idempotencyKey) {
        const existing = await ProductionRun.findOne({ idempotencyKey: value.idempotencyKey }).session(session).lean();
        if (existing) {
          const sameRequest = String(existing.productId) === value.productId
            && existing.productionDate === value.productionDate
            && existing.openingStockPieces === Number(value.openingStockPieces)
            && existing.salesQuantityPieces === Number(value.salesQuantityPieces)
            && existing.damagedQuantityPieces === Number(value.damagedQuantityPieces)
            && existing.closingStockPieces === Number(value.closingStockPieces)
            && existing.damageReason === (value.damageReason?.trim() ?? "");
          if (!sameRequest) throw conflictError("Idempotency key was already used for a different production request.");
          return { run: serialize(existing), replayed: true };
        }
      }
      const product = await FinishedProduct.findOne({ _id: value.productId, active: true }).session(session);
      if (!product) {
        const missing = new Error("Product not found or inactive.");
        missing.statusCode = 404;
        throw missing;
      }
      const existingRun = await ProductionRun.findOne({
        productId: product._id,
        productionDate: value.productionDate,
      }).session(session).lean();
      if (existingRun) {
        const conflict = new Error("A production record already exists for this product and date.");
        conflict.statusCode = 409;
        throw conflict;
      }
      const currentOpening = await getFinishedBalance(product._id, session);
      if (currentOpening !== Number(value.openingStockPieces)) {
        const conflict = new Error(`Opening stock changed. Current server balance is ${currentOpening} pieces; refresh and reconcile the physical count.`);
        conflict.statusCode = 409;
        throw conflict;
      }
      const materializedRecipe = product.activeRecipeId
        ? await ProductionRecipe.findById(product.activeRecipeId).session(session).lean()
        : null;
      if (product.recipeRequired && !materializedRecipe) {
        const missingRecipe = new Error("This product requires a recipe before production can be recorded.");
        missingRecipe.statusCode = 409;
        throw missingRecipe;
      }
      const latestFinishedMovement = await FinishedStockMovement.findOne({ productId: product._id })
        .sort({ date: -1, createdAt: -1 })
        .session(session)
        .lean();
      if (latestFinishedMovement && latestFinishedMovement.date > value.productionDate) {
        throw conflictError("Production must be recorded on or after the latest finished-stock movement date.");
      }
      const lines = [];
      const reference = `PROD-${randomUUID()}`;
      const [run] = await ProductionRun.create([{
        reference,
        productId: product._id,
        productName: product.name,
        productUnit: product.unit,
        recipeId: materializedRecipe?._id ?? null,
        recipeVersion: materializedRecipe?.version ?? null,
        productionDate: value.productionDate,
        openingStockPieces: Number(value.openingStockPieces),
        salesQuantityPieces: Number(value.salesQuantityPieces),
        damagedQuantityPieces: Number(value.damagedQuantityPieces),
        closingStockPieces: Number(value.closingStockPieces),
        producedQuantityPieces: value.producedQuantityPieces,
        damageReason: value.damageReason?.trim() ?? "",
        lines,
        idempotencyKey: value.idempotencyKey,
        actor: actorId(request),
      }], { session });
      const finishedMovementInputs = [
        ...(value.producedQuantityPieces > 0 ? [{ type: "Production", direction: "in", quantityPieces: value.producedQuantityPieces, reason: "Calculated daily production" }] : []),
        ...(Number(value.damagedQuantityPieces) > 0 ? [{ type: "Damage/write-off", direction: "out", quantityPieces: Number(value.damagedQuantityPieces), reason: value.damageReason.trim() }] : []),
      ];
      for (const movementInput of finishedMovementInputs) {
        await recordFinishedStockMovement({
          ...movementInput,
          productId: product._id,
          date: value.productionDate,
          reference,
          sourceType: "production",
          sourceId: run._id,
          productName: product.name,
          actor: actorId(request),
        }, session);
      }
      await audit.recordAudit({
        request,
        eventType: "production.run_recorded",
        outcome: "success",
        details: { productionRunId: String(run._id), reference, productId: String(product._id), producedQuantityPieces: value.producedQuantityPieces, ingredientCount: 0, rawMaterialUsagePostedSeparately: Boolean(materializedRecipe) },
        transaction: session,
      });
      return { run: serialize(run), balancePieces: await getFinishedBalance(product._id, session) };
    });
    return response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

async function listStockBalances(_request, response) {
  const [products, finishedBalances, materials, rawBalances] = await Promise.all([
    FinishedProduct.find({ active: true }).sort({ name: 1 }).lean(),
    FinishedStockBalance.find().lean(),
    RawMaterial.find({ active: true }).sort({ name: 1 }).lean(),
    RawMaterialBalance.find().lean(),
  ]);
  const finishedMap = new Map(finishedBalances.map((item) => [String(item.productId), item]));
  const rawMap = new Map();
  for (const item of rawBalances) {
    const key = String(item.materialId);
    rawMap.set(key, (rawMap.get(key) ?? 0) + item.quantity);
  }
  return response.json({
    finishedGoods: products.map((product) => ({
      productId: String(product._id),
      productName: product.name,
      unit: product.unit,
      packType: product.packType,
      piecesPerPack: product.piecesPerPack,
      balancePieces: finishedMap.get(String(product._id))?.quantityPieces ?? 0,
      reservedPieces: finishedMap.get(String(product._id))?.reservedPieces ?? 0,
      availablePieces: Math.max(0, (finishedMap.get(String(product._id))?.quantityPieces ?? 0) - (finishedMap.get(String(product._id))?.reservedPieces ?? 0)),
    })),
    rawMaterials: materials.map((material) => ({
      materialId: String(material._id),
      materialName: material.name,
      unit: material.unit,
      balance: rawMap.get(String(material._id)) ?? 0,
    })),
  });
}

module.exports = {
  adjustRawMaterial,
  adjustFinishedStock,
  changeRecipe,
  createMaterial,
  createProduct,
  createProductionRun,
  configureMaterialLocation,
  listInventoryResponsibleUsers,
  listLowStockAlerts,
  listMaterialReceipts,
  listProductionMaterialUsages,
  listFinishedMovements,
  listMaterials,
  listProductionRuns,
  listProducts,
  listRawMovements,
  listStockBalances,
  postProductionMaterialUsage,
  receiveFinishedStock,
  receiveRawMaterial,
  transferRawMaterial,
  updateProduct,
  validateIngredients,
  validateProduct,
  calculateProductionMaterialLines,
  validateProductionUsageInput,
  validateProductionInput,
};
