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

function companyWorkDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
      return { error: "Every finished product must have one configured box or carton as its sellable unit." };
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

function validatePackagingLevels(value, baseUnit) {
  if (!Array.isArray(value) || value.length > 6) {
    return { error: "Packaging levels must be an array of at most 6 levels." };
  }
  const names = new Set();
  const levels = [];
  let baseUnitsPerPackage = 1;
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => !["name", "quantity"].includes(key))) {
      return { error: "Each packaging level must contain only a name and quantity." };
    }
    if (typeof item.name !== "string" || typeof item.quantity !== "number"
      || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1_000_000_000) {
      return { error: "Packaging names must be text and quantities must be positive finite numbers." };
    }
    const name = item.name.trim();
    const key = name.toLocaleLowerCase();
    if (!name || name.length > 40 || key === baseUnit.trim().toLocaleLowerCase() || names.has(key)) {
      return { error: "Packaging level names must be unique, non-empty, and different from the base unit." };
    }
    if (index > 0 && !Number.isInteger(item.quantity)) {
      return { error: "Nested package quantities must be whole numbers of the previous package." };
    }
    baseUnitsPerPackage *= item.quantity;
    if (!Number.isFinite(baseUnitsPerPackage) || baseUnitsPerPackage > 1_000_000_000_000) {
      return { error: "Packaging conversion is too large." };
    }
    names.add(key);
    levels.push({ name, quantity: item.quantity });
  }
  return { value: levels };
}

function packagingConversions(material) {
  let baseUnitsPerPackage = 1;
  return (material.packagingLevels ?? []).map((level) => {
    baseUnitsPerPackage *= level.quantity;
    return { name: level.name, baseUnitsPerPackage };
  });
}

function validateMaterialInput(body) {
  if (!requestObject(body, ["code", "name", "category", "unit", "packagingLevels"])
    || typeof body.code !== "string" || typeof body.name !== "string"
    || typeof body.unit !== "string"
    || (body.category !== undefined && typeof body.category !== "string")) {
    return { error: "Provide material code, name, category, and unit." };
  }
  const code = body.code.trim();
  const name = body.name.trim();
  const category = String(body.category || "General").trim();
  const unit = body.unit.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(code) || !name || name.length > 160
    || !category || category.length > 80 || !unit || unit.length > 24) {
    return { error: "Material code, name, category, and unit are invalid." };
  }
  const packaging = validatePackagingLevels(body.packagingLevels ?? [], unit);
  if (packaging.error) return packaging;
  return { value: { code, name, category, unit, packagingLevels: packaging.value } };
}

async function hasCurrentOrPendingRecipeUsage(materialId, session) {
  const recipes = await ProductionRecipe.find({ "ingredients.materialId": materialId })
    .select("_id").session(session).lean();
  if (!recipes.length) return false;
  const recipeIds = recipes.map((recipe) => recipe._id);
  const [currentRecipe, pendingRuns] = await Promise.all([
    FinishedProduct.exists({ activeRecipeId: { $in: recipeIds } }).session(session),
    ProductionRun.find({ recipeId: { $in: recipeIds } }).select("_id").session(session).lean(),
  ]);
  if (currentRecipe) return true;
  if (!pendingRuns.length) return false;
  const postedRunIds = await ProductionMaterialUsage.distinct("productionRunId", {
    productionRunId: { $in: pendingRuns.map((run) => run._id) },
  }).session(session);
  const postedRunIdSet = new Set(postedRunIds.map(String));
  return pendingRuns.some((run) => !postedRunIdSet.has(String(run._id)));
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
      balancePacks: balanceMap.get(String(product._id))?.quantityPacks ?? 0,
      reservedPacks: balanceMap.get(String(product._id))?.reservedPacks ?? 0,
      availablePacks: Math.max(0, (balanceMap.get(String(product._id))?.quantityPacks ?? 0) - (balanceMap.get(String(product._id))?.reservedPacks ?? 0)),
      loosePieces: balanceMap.get(String(product._id))?.loosePieces ?? 0,
      inventoryEffectiveDate: balanceMap.get(String(product._id))?.inventoryEffectiveDate ?? companyWorkDate(),
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
        inventoryUnit: "pack",
        quantityPacks: 0,
        reservedPacks: 0,
        loosePieces: 0,
        openingQuantityPacks: 0,
        inventoryEffectiveDate: companyWorkDate(),
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
      return {
        product: {
          ...serialize(product),
          balancePacks: 0,
          reservedPacks: 0,
          availablePacks: 0,
          loosePieces: 0,
          inventoryEffectiveDate: companyWorkDate(),
          recipe: recipe ? serialize(recipe) : null,
        },
      };
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
      const packChanged = (own(value, "packType") && value.packType !== record.packType)
        || (own(value, "piecesPerPack") && value.piecesPerPack !== record.piecesPerPack);
      if (unitChanged || packChanged) {
        const [balance, hasRuns, hasMovements] = await Promise.all([
          FinishedStockBalance.findOne({ productId: record._id }).session(session).lean(),
          ProductionRun.exists({ productId: record._id }).session(session),
          FinishedStockMovement.exists({ productId: record._id }).session(session),
        ]);
        if ((balance?.quantityPacks ?? 0) > 0 || (balance?.loosePieces ?? 0) > 0 || hasRuns || hasMovements) {
          const immutableUnit = new Error("The product's sellable unit and pack size cannot change after stock or production history exists.");
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
  const validation = validateMaterialInput(request.body);
  if (validation.error) return statusError(response, 400, validation.error);
  const { code, name, category, unit, packagingLevels } = validation.value;
  try {
    const result = await withTransaction(async (session) => {
      const [material] = await RawMaterial.create([{
        code,
        name,
        category,
        unit,
        packagingLevels,
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

function validateReceiptInput(body, material) {
  const allowed = [
    "quantity", "date", "reference", "reason", "idempotencyKey", "location",
    "supplier", "sourceReference", "unitCost", "packageUnit", "packageQuantity",
    "packagePrice",
  ];
  if (!requestObject(body, allowed)) return { error: "Receipt contains unsupported fields." };
  if (!validDate(body.date) || typeof body.reason !== "string"
    || !body.reason.trim() || body.reason.trim().length > 300) {
    return { error: "Provide a valid receipt date and reason." };
  }
  const hasPackageInput = ["packageUnit", "packageQuantity", "packagePrice"].some((key) => own(body, key));
  if (hasPackageInput) {
    if (own(body, "quantity") || own(body, "unitCost")) {
      return { error: "Use package quantity and package price, not base-unit quantity or unit cost." };
    }
    if (!own(body, "packageUnit") || !own(body, "packageQuantity") || !own(body, "packagePrice")
      || typeof body.packageUnit !== "string" || !body.packageUnit.trim()
      || typeof body.packageQuantity !== "number" || !Number.isInteger(body.packageQuantity)
      || !positive(body.packageQuantity) || body.packageQuantity > 1_000_000_000
      || typeof body.packagePrice !== "number" || !Number.isFinite(body.packagePrice) || body.packagePrice < 0) {
      return { error: "Choose a configured package unit, enter a positive whole package count, and enter a non-negative package price." };
    }
    const packageUnit = body.packageUnit.trim();
    const conversion = packagingConversions(material).find((level) => level.name === packageUnit);
    const isLegacyBaseUnit = !(material.packagingLevels ?? []).length && packageUnit === material.unit;
    if (!conversion && !isLegacyBaseUnit) {
      return { error: "Receipt unit must be a packaging level configured for this material." };
    }
    const baseUnitsPerPackage = conversion?.baseUnitsPerPackage ?? 1;
    return {
      value: {
        quantity: body.packageQuantity * baseUnitsPerPackage,
        unitCost: body.packagePrice / baseUnitsPerPackage,
        receiptPackaging: {
          packageQuantity: body.packageQuantity,
          packageUnit,
          baseUnitsPerPackage,
          packagePrice: body.packagePrice,
        },
      },
    };
  }

  if ((material.packagingLevels ?? []).length) {
    return { error: "Select a configured package unit and enter its package price." };
  }
  if (typeof body.quantity !== "number" || !positive(body.quantity)
    || (body.unitCost !== undefined && (typeof body.unitCost !== "number" || !Number.isFinite(body.unitCost) || body.unitCost < 0))) {
    return { error: "Provide a positive base-unit quantity and a non-negative unit cost." };
  }
  return {
    value: {
      quantity: body.quantity,
      unitCost: body.unitCost,
      receiptPackaging: undefined,
    },
  };
}

async function updateMaterial(request, response) {
  if (!validObjectId(request.params.materialId)) return statusError(response, 400, "Choose a valid raw material.");
  const validation = validateMaterialInput(request.body);
  if (validation.error) return statusError(response, 400, validation.error);
  try {
    const result = await withTransaction(async (session) => {
      const material = await RawMaterial.findById(request.params.materialId).session(session);
      if (!material) return { notFound: true };

      const { code, name, category, unit, packagingLevels } = validation.value;
      if (unit !== material.unit) {
        const [movement, balance, productRecipes] = await Promise.all([
          RawMaterialMovement.exists({ materialId: material._id }).session(session),
          RawMaterialBalance.exists({
            materialId: material._id,
            $or: [{ quantity: { $gt: 0 } }, { reorderThreshold: { $gt: 0 } }],
          }).session(session),
          hasCurrentOrPendingRecipeUsage(material._id, session),
        ]);
        if (movement || balance || productRecipes) {
          throw conflictError("The base unit cannot be changed after stock movements, non-zero balances or reorder thresholds, or current product recipes or pending production runs exist.");
        }
      }

      material.code = code;
      material.name = name;
      material.category = category;
      material.unit = unit;
      material.packagingLevels = packagingLevels;
      material.updatedBy = actorId(request);
      await material.save({ session });
      await audit.recordAudit({
        request,
        eventType: "production.material_updated",
        outcome: "success",
        details: { materialId: String(material._id), code, name, category, unit },
        transaction: session,
      });
      return { material: serialize(material) };
    });
    if (result.notFound) return statusError(response, 404, "Raw material not found.");
    return response.json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

async function deleteMaterial(request, response) {
  if (!validObjectId(request.params.materialId)) return statusError(response, 400, "Choose a valid raw material.");
  try {
    const result = await withTransaction(async (session) => {
      const material = await RawMaterial.findById(request.params.materialId).session(session);
      if (!material) return { notFound: true };

      if (await hasCurrentOrPendingRecipeUsage(material._id, session)) {
        throw conflictError("This material is used by a current product recipe or a pending production run. Update the recipe or post the pending material use before deleting it.");
      }

      const [balances, preservedMovementCount] = await Promise.all([
        RawMaterialBalance.find({ materialId: material._id }).session(session).lean(),
        RawMaterialMovement.countDocuments({ materialId: material._id }).session(session),
      ]);
      const deletedStock = balances.reduce((total, balance) => total + balance.quantity, 0);
      await RawMaterialBalance.deleteMany({ materialId: material._id }, { session });
      await RawMaterialAlert.deleteMany({ materialId: material._id }, { session });
      await RawMaterial.deleteOne({ _id: material._id }, { session });
      await audit.recordAudit({
        request,
        eventType: "production.material_deleted",
        outcome: "success",
        details: {
          materialId: String(material._id),
          code: material.code,
          name: material.name,
          deletedStock,
          deletedLocationCount: balances.length,
          preservedMovementCount,
        },
        transaction: session,
      });
      return {
        deleted: true,
        materialId: String(material._id),
        deletedUnit: material.unit,
        deletedStock,
        deletedLocationCount: balances.length,
        preservedMovementCount,
      };
    });
    if (result.notFound) return statusError(response, 404, "Raw material not found.");
    return response.json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

function sameRawMaterialReceiptRequest(existing, input) {
  return String(existing.materialId) === input.materialId
    && ["Receipt", "Stock in"].includes(existing.type)
    && existing.quantity === input.quantity
    && existing.date === input.date
    && existing.reason === input.reason
    && (existing.toLocation || "Main Warehouse") === input.destination
    && (input.reference === undefined || existing.receiptReference === input.reference)
    && (existing.supplier || "") === (input.supplier || "")
    && (existing.sourceReference || "") === (input.sourceReference || "")
    && (existing.receiptPackaging?.packageQuantity ?? null) === (input.receiptPackaging?.packageQuantity ?? null)
    && (existing.receiptPackaging?.packageUnit ?? null) === (input.receiptPackaging?.packageUnit ?? null)
    && (existing.receiptPackaging?.baseUnitsPerPackage ?? null) === (input.receiptPackaging?.baseUnitsPerPackage ?? null)
    && (existing.receiptPackaging?.packagePrice ?? existing.unitCost ?? null) === (input.receiptPackaging?.packagePrice ?? input.unitCost ?? null);
}

async function receiveRawMaterial(request, response) {
  const { materialId } = request.params;
  const body = request.body || {};
  const { date, reference, reason, idempotencyKey, location, supplier, sourceReference } = body;
  if (!validObjectId(materialId)) return statusError(response, 400, "Provide a valid material ID.");
  const destination = typeof location === "string" && location.trim() ? location.trim() : "Main Warehouse";
  if (destination.length > 100 || (supplier !== undefined && (typeof supplier !== "string" || supplier.trim().length > 160))
    || (sourceReference !== undefined && (typeof sourceReference !== "string" || sourceReference.trim().length > 120))) {
    return statusError(response, 400, "Location, supplier, or source reference is invalid.");
  }
  if (reference !== undefined && (typeof reference !== "string" || reference.trim().length > 80)) {
    return statusError(response, 400, "Reference must be 80 characters or fewer.");
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 120)) {
    return statusError(response, 400, "Idempotency key must be 1–120 characters.");
  }
  try {
    const result = await withTransaction(async (session) => {
      const material = await RawMaterial.findOne({ _id: materialId, active: true }).session(session);
      if (!material) {
        const missing = new Error("Material not found or inactive.");
        missing.statusCode = 404;
        throw missing;
      }
      const validation = validateReceiptInput(body, material);
      if (validation.error) {
        const invalidReceipt = new Error(validation.error);
        invalidReceipt.statusCode = 400;
        throw invalidReceipt;
      }
      const { quantity, unitCost, receiptPackaging } = validation.value;
      if (idempotencyKey) {
        const existing = await RawMaterialMovement.findOne({ idempotencyKey }).session(session).lean();
        if (existing) {
          const sameRequest = sameRawMaterialReceiptRequest(existing, {
            materialId,
            quantity,
            date,
            reason: reason.trim(),
            destination,
            reference: reference?.trim() || undefined,
            supplier: supplier?.trim() || undefined,
            sourceReference: sourceReference?.trim() || undefined,
            receiptPackaging,
            unitCost,
          });
          if (!sameRequest) throw conflictError("Idempotency key was already used for a different raw-material request.");
          return { movement: serialize(existing), balance: await getRawMaterialBalance(materialId, session, destination) };
        }
      }
      const movement = await recordRawMaterialMovement({
        materialId: material._id,
        type: "Stock in",
        direction: "in",
        quantity,
        date,
        reference: reference?.trim() || `RM-${randomUUID()}`,
        receiptReference: reference?.trim() || undefined,
        sourceType: "receipt",
        idempotencyKey,
        reason: reason.trim(),
        toLocation: destination,
        supplier: supplier?.trim() || undefined,
        sourceReference: sourceReference?.trim() || undefined,
        unitCost,
        receiptPackaging,
        materialName: material.name,
        unit: material.unit,
        actor: actorId(request),
      }, session);
      await audit.recordAudit({
        request,
        eventType: "inventory.raw_material_received",
        outcome: "success",
        details: { materialId: String(material._id), location: destination, quantity, unit: material.unit, movementId: String(movement._id) },
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
  if (!requestObject(body, ["productionRunId", "productId", "productionDate", "tanksProduced", "location", "idempotencyKey"])) {
    return { error: "Production usage contains unsupported fields." };
  }
  const isRunBased = own(body, "productionRunId");
  if (isRunBased === (own(body, "productId") || own(body, "productionDate"))
    || (isRunBased && !validObjectId(body.productionRunId))
    || (!isRunBased && (!validObjectId(body.productId) || !validDate(body.productionDate)))
    || !positive(Number(body.tanksProduced))
    || typeof body.location !== "string" || !body.location.trim() || body.location.trim().length > 100) {
    return { error: "Provide either a valid production run or a product and production date, plus positive tank count and stock location." };
  }
  if (body.idempotencyKey !== undefined
    && (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 120)) {
    return { error: "Idempotency key must be 1–120 characters." };
  }
  if (!isRunBased && body.idempotencyKey === undefined) {
    return { error: "Direct product usage requires an idempotency key." };
  }
  return {
    value: {
      productionRunId: body.productionRunId,
      productId: body.productId,
      productionDate: body.productionDate,
      tanksProduced: Number(body.tanksProduced),
      location: body.location.trim(),
      idempotencyKey: body.idempotencyKey?.trim(),
    },
  };
}

function validateProductionUsageUpdateInput(body) {
  if (!requestObject(body, ["productId", "productionDate", "tanksProduced", "location"])
    || !validObjectId(body.productId)
    || !validDate(body.productionDate)
    || !positive(Number(body.tanksProduced))
    || typeof body.location !== "string"
    || !body.location.trim()
    || body.location.trim().length > 100) {
    return { error: "Provide a valid product, production date, positive tank count, and stock location." };
  }
  return {
    value: {
      productId: body.productId,
      productionDate: body.productionDate,
      tanksProduced: Number(body.tanksProduced),
      location: body.location.trim(),
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

function calculateProductionUsageStockDeltas(previousLines, previousLocation, nextLines, nextLocation) {
  const deltas = new Map();
  const addDelta = (line, location, quantity) => {
    const key = `${String(line.materialId)}:${location}`;
    const current = deltas.get(key) || {
      materialId: line.materialId,
      materialName: line.materialName,
      unit: line.unit,
      location,
      delta: 0,
    };
    current.delta += quantity;
    deltas.set(key, current);
  };
  for (const line of previousLines) addDelta(line, previousLocation, line.totalQuantity);
  for (const line of nextLines) addDelta(line, nextLocation, -line.totalQuantity);
  return [...deltas.values()].filter((item) => Math.abs(item.delta) >= 1e-9);
}

async function postProductionMaterialUsage(request, response) {
  const { value, error } = validateProductionUsageInput(request.body);
  if (error) return statusError(response, 400, error);
  try {
    const result = await withTransaction(async (session) => {
      if (value.idempotencyKey) {
        const existing = await ProductionMaterialUsage.findOne({ idempotencyKey: value.idempotencyKey }).session(session).lean();
        if (existing) {
          const sameIdentity = value.productionRunId
            ? String(existing.productionRunId ?? "") === value.productionRunId
            : !existing.productionRunId
              && String(existing.productId) === value.productId
              && existing.productionDate === value.productionDate;
          const sameRequest = sameIdentity
            && existing.tanksProduced === value.tanksProduced
            && existing.location === value.location;
          if (!sameRequest) throw conflictError("Idempotency key was already used for a different production-usage request.");
          return { usage: serialize(existing), replayed: true };
        }
      }
      const run = value.productionRunId
        ? await ProductionRun.findById(value.productionRunId).session(session)
        : null;
      if (value.productionRunId && !run) {
        const missing = new Error("Production run not found.");
        missing.statusCode = 404;
        throw missing;
      }
      if (run) {
        const existingUsage = await ProductionMaterialUsage.findOne({ productionRunId: run._id }).session(session).lean();
        if (existingUsage) throw conflictError("Raw-material usage has already been recorded for this production run.");
      }
      const product = await FinishedProduct.findOne({
        _id: run?.productId ?? value.productId,
        active: true,
      }).session(session);
      if (!product) {
        const missing = new Error("The selected product is missing or inactive.");
        missing.statusCode = 409;
        throw missing;
      }
      const recipeId = run ? run.recipeId : product.activeRecipeId;
      if (!recipeId) {
        const missingRecipe = new Error("The selected product has no saved recipe. Add a recipe before recording its material use.");
        missingRecipe.statusCode = 409;
        throw missingRecipe;
      }
      const recipe = await ProductionRecipe.findById(recipeId).session(session).lean();
      if (!recipe || String(recipe.productId) !== String(product._id)
        || recipe.tankVolumeLitres !== 1000 || !recipe.ingredients.length) {
        const missingRecipe = new Error("The selected recipe is missing or does not use the 1,000-litre tank basis.");
        missingRecipe.statusCode = 409;
        throw missingRecipe;
      }
      const productionDate = run?.productionDate ?? value.productionDate;
      const productName = run?.productName ?? product.name;
      const lines = [];
      for (const ingredient of recipe.ingredients) {
        const material = await RawMaterial.findOne({ _id: ingredient.materialId, active: true }).session(session);
        if (!material || material.unit !== ingredient.unit) {
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
        if (latestMovement && latestMovement.date > productionDate) {
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
        ...(run ? { productionRunId: run._id } : {}),
        productId: product._id,
        productName,
        productionDate,
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
          date: productionDate,
          reference,
          sourceType: "production-usage",
          sourceId: usage._id,
          reason: `${value.tanksProduced} × 1,000-litre tanks of ${productName}`,
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
          productionRunId: run ? String(run._id) : undefined,
          reference,
          productId: String(product._id),
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

async function updateProductionMaterialUsage(request, response) {
  if (!validObjectId(request.params.id)) return statusError(response, 400, "Production usage id is invalid.");
  const { value, error } = validateProductionUsageUpdateInput(request.body);
  if (error) return statusError(response, 400, error);
  try {
    const result = await withTransaction(async (session) => {
      const usage = await ProductionMaterialUsage.findById(request.params.id).session(session);
      if (!usage) {
        const missing = new Error("Production material usage record not found.");
        missing.statusCode = 404;
        throw missing;
      }
      if (usage.productionRunId) {
        throw conflictError("Legacy run-linked production usage is read-only. Update the production run through its supported workflow.");
      }

      const product = await FinishedProduct.findOne({ _id: value.productId, active: true }).session(session);
      if (!product) throw conflictError("The selected product is missing or inactive.");
      if (!product.activeRecipeId) {
        throw conflictError("The selected product has no saved recipe. Add a recipe before editing material use.");
      }
      const recipe = await ProductionRecipe.findById(product.activeRecipeId).session(session).lean();
      if (!recipe || String(recipe.productId) !== String(product._id)
        || recipe.tankVolumeLitres !== 1000 || !recipe.ingredients.length) {
        throw conflictError("The selected recipe is missing or does not use the 1,000-litre tank basis.");
      }

      const materialsById = new Map();
      const newIngredients = [];
      for (const ingredient of recipe.ingredients) {
        const material = await RawMaterial.findOne({ _id: ingredient.materialId, active: true }).session(session);
        if (!material || material.unit !== ingredient.unit) {
          throw conflictError("A recipe ingredient is missing or inactive. Update the product recipe before editing use.");
        }
        const locationBalance = await RawMaterialBalance.findOne({
          materialId: material._id,
          location: value.location,
        }).session(session).lean();
        if (!locationBalance) {
          throw conflictError(`${material.name} has no inventory configured at ${value.location}.`);
        }
        materialsById.set(String(material._id), material);
        newIngredients.push({
          materialId: material._id,
          materialName: material.name,
          unit: material.unit,
          quantityPerTank: ingredient.quantityPerTank,
        });
      }
      const newLines = calculateProductionMaterialLines(newIngredients, value.tanksProduced);
      for (const line of usage.lines) {
        const materialId = String(line.materialId);
        let material = materialsById.get(materialId);
        if (!material) {
          material = await RawMaterial.findById(line.materialId).session(session);
          if (!material || material.unit !== line.unit) {
            throw conflictError(`The previously used material ${line.materialName} is missing or has changed units; this record cannot be safely edited.`);
          }
          materialsById.set(materialId, material);
        }
        const oldBalance = await RawMaterialBalance.findOne({
          materialId: line.materialId,
          location: usage.location,
        }).session(session).lean();
        if (!oldBalance) {
          throw conflictError(`${line.materialName} no longer has inventory configured at ${usage.location}; this record cannot be safely edited.`);
        }
      }
      const stockDeltas = calculateProductionUsageStockDeltas(usage.lines, usage.location, newLines, value.location);

      const correctionDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Kampala",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const correctionReference = `${usage.reference}-E-${randomUUID()}`;
      for (const delta of stockDeltas) {
        const direction = delta.delta > 0 ? "in" : "out";
        await recordRawMaterialMovement({
          materialId: delta.materialId,
          type: "Production use correction",
          direction,
          quantity: Math.abs(delta.delta),
          date: correctionDate,
          reference: correctionReference,
          sourceType: "production-usage-correction",
          sourceId: usage._id,
          reason: `Correction for production usage ${usage.reference}`,
          ...(direction === "in" ? { toLocation: delta.location } : { fromLocation: delta.location }),
          materialName: delta.materialName,
          unit: delta.unit,
          actor: actorId(request),
        }, session);
      }

      const previous = {
        productId: String(usage.productId),
        productionDate: usage.productionDate,
        tanksProduced: usage.tanksProduced,
        location: usage.location,
        recipeVersion: usage.recipeVersion,
      };
      usage.productId = product._id;
      usage.productName = product.name;
      usage.productionDate = value.productionDate;
      usage.tanksProduced = value.tanksProduced;
      usage.location = value.location;
      usage.recipeId = recipe._id;
      usage.recipeVersion = recipe.version;
      usage.lines = newLines;
      usage.updatedBy = actorId(request);
      await usage.save({ session });

      await audit.recordAudit({
        request,
        eventType: "inventory.production_material_usage_updated",
        outcome: "success",
        details: {
          productionUsageId: String(usage._id),
          reference: usage.reference,
          correctionReference,
          previous,
          updated: {
            productId: String(product._id),
            productionDate: value.productionDate,
            tanksProduced: value.tanksProduced,
            location: value.location,
            recipeVersion: recipe.version,
          },
          correctionMovementCount: stockDeltas.length,
        },
        transaction: session,
      });
      return { usage: serialize(usage) };
    });
    return response.json(result);
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
    ? ["productId", "direction", "quantityPacks", "date", "reason", "reference", "idempotencyKey"]
    : ["productId", "quantityPacks", "date", "reason", "reference", "idempotencyKey"];
  if (!requestObject(request.body, allowed)) return statusError(response, 400, "Movement contains unsupported fields.");
  const { productId, quantityPacks, date, reason, reference, idempotencyKey } = request.body;
  if (!validObjectId(productId) || !Number.isInteger(Number(quantityPacks)) || Number(quantityPacks) <= 0 || !validDate(date)
    || typeof reason !== "string" || !reason.trim() || reason.trim().length > 300) {
    return statusError(response, 400, "Provide a valid product, positive whole-pack quantity, date, and reason.");
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
            && existing.inventoryUnit === "pack"
            && existing.quantityPacks === Number(quantityPacks)
            && existing.date === date
            && existing.reason === reason.trim();
          if (!sameRequest) throw conflictError("Idempotency key was already used for a different finished-stock request.");
          return { movement: serialize(existing), balancePacks: await getFinishedBalance(productId, session) };
        }
      }
      const product = await FinishedProduct.findOne({ _id: productId, active: true }).session(session);
      if (!product) {
        const missing = new Error("Product not found or inactive.");
        missing.statusCode = 404;
        throw missing;
      }
      if (!product.packType || !Number.isInteger(product.piecesPerPack) || product.piecesPerPack < 1) {
        throw conflictError("Configure this product's box or carton size before recording finished stock.");
      }
      if (date > companyWorkDate()) {
        throw conflictError("Finished-stock movements cannot be dated in the future.");
      }
      const balance = await FinishedStockBalance.findOne({ productId: product._id }).session(session).lean();
      const effectiveDate = balance?.inventoryEffectiveDate ?? companyWorkDate();
      if (date < effectiveDate) {
        throw conflictError(`Pack-based finished-stock movements can only be dated on or after ${effectiveDate}.`);
      }
      const laterMovement = await FinishedStockMovement.findOne({
        productId: product._id,
        inventoryUnit: "pack",
        date: { $gt: date },
      }).session(session).lean();
      if (laterMovement) {
        throw conflictError("Finished-stock movements cannot be backdated before a later pack-based movement.");
      }
      const amount = Number(quantityPacks);
      const type = adjustment
        ? direction === "in" ? "Adjustment increase" : "Adjustment decrease"
        : "Other stock in";
      const movement = await recordFinishedStockMovement({
        productId: product._id,
        type,
        direction,
        inventoryUnit: "pack",
        quantityPacks: amount,
        packTypeSnapshot: product.packType,
        piecesPerPackSnapshot: product.piecesPerPack,
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
        details: { productId: String(product._id), quantityPacks: amount, packType: product.packType, direction, movementId: String(movement._id), reason: reason.trim() },
        transaction: session,
      });
      return { movement: serialize(movement), balancePacks: await getFinishedBalance(product._id, session) };
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

async function dailyStockSummary(productId, date, session) {
  const balanceQuery = FinishedStockBalance.findOne({ productId });
  if (session) balanceQuery.session(session);
  const balance = await balanceQuery.lean();
  if (!balance || balance.inventoryUnit !== "pack") {
    throw conflictError("Finished stock has not been migrated to box/carton units. Run the finished-stock migration first.");
  }
  if (date < balance.inventoryEffectiveDate) {
    throw conflictError(`Pack-based daily stock records can only be posted on or after ${balance.inventoryEffectiveDate}.`);
  }
  const productQuery = FinishedProduct.findById(productId);
  if (session) productQuery.session(session);
  const product = await productQuery.lean();
  if (!product?.packType || !Number.isInteger(product.piecesPerPack) || product.piecesPerPack < 1) {
    throw conflictError("Configure this product's box or carton size before recording daily production.");
  }
  const latestMovementQuery = FinishedStockMovement.findOne({
    productId,
    inventoryUnit: "pack",
    date: { $gt: date },
  }).sort({ date: -1 });
  if (session) latestMovementQuery.session(session);
  if (await latestMovementQuery.lean()) {
    throw conflictError("Daily production must be posted on or after the latest finished-stock movement date.");
  }
  const movementQuery = FinishedStockMovement.find({ productId, inventoryUnit: "pack", date });
  if (session) movementQuery.session(session);
  const movements = await movementQuery.lean();
  const netFor = (movement) => movement.direction === "in" ? movement.quantityPacks : -movement.quantityPacks;
  const dayNet = movements.reduce((total, movement) => total + netFor(movement), 0);
  const salesQuantityPacks = movements
    .filter((movement) => movement.type === "Sales dispatch")
    .reduce((total, movement) => total + movement.quantityPacks, 0);
  const otherMovementNetPacks = movements
    .filter((movement) => !["Sales dispatch", "Production", "Damage/write-off"].includes(movement.type))
    .reduce((total, movement) => total + netFor(movement), 0);
  return {
    product,
    balance,
    openingStockPacks: balance.quantityPacks - dayNet,
    salesQuantityPacks,
    otherMovementNetPacks,
    piecesPerPack: product.piecesPerPack,
    packType: product.packType,
  };
}

function calculateProducedPacks({ closingStockPacks, salesQuantityPacks, damagedQuantityPacks, openingStockPacks, otherMovementNetPacks }) {
  return closingStockPacks + salesQuantityPacks + damagedQuantityPacks - openingStockPacks - otherMovementNetPacks;
}

async function getDailyProductionStockSummary(request, response) {
  const { productId, date } = request.query;
  if (!validObjectId(productId)) return statusError(response, 400, "productId is invalid.");
  if (!validDate(date)) return statusError(response, 400, "Production date must be a valid YYYY-MM-DD date.");
  try {
    const summary = await dailyStockSummary(productId, date);
    return response.json({
      productId,
      productionDate: date,
      packType: summary.packType,
      piecesPerPack: summary.piecesPerPack,
      openingStockPacks: summary.openingStockPacks,
      salesQuantityPacks: summary.salesQuantityPacks,
      otherMovementNetPacks: summary.otherMovementNetPacks,
      loosePieces: summary.balance.loosePieces ?? 0,
    });
  } catch (error) {
    return nextError(error, response);
  }
}

function validateProductionInput(body) {
  const allowed = ["productId", "productionDate", "openingStockPacks", "damagedQuantityPacks", "closingStockPacks", "damageReason", "idempotencyKey"];
  if (!requestObject(body, allowed)) return { error: "Production record contains unsupported fields." };
  if (!validObjectId(body.productId)) return { error: "Choose a valid product." };
  if (!validDate(body.productionDate)) return { error: "Production date must be a valid YYYY-MM-DD date." };
  if (body.productionDate > companyWorkDate()) return { error: "Production date cannot be in the future." };
  for (const field of ["openingStockPacks", "damagedQuantityPacks", "closingStockPacks"]) {
    if (!Number.isInteger(Number(body[field])) || Number(body[field]) < 0) return { error: `${field} must be a non-negative whole number of boxes or cartons.` };
  }
  if (Number(body.damagedQuantityPacks) > 0 && (typeof body.damageReason !== "string" || !body.damageReason.trim())) {
    return { error: "A damage reason is required when damaged quantity is greater than zero." };
  }
  if (body.damageReason !== undefined && (typeof body.damageReason !== "string" || body.damageReason.trim().length > 300)) {
    return { error: "Damage reason must be 300 characters or fewer." };
  }
  if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 120)) {
    return { error: "Idempotency key must be 1–120 characters." };
  }
  return {
    value: {
      ...body,
      openingStockPacks: Number(body.openingStockPacks),
      damagedQuantityPacks: Number(body.damagedQuantityPacks),
      closingStockPacks: Number(body.closingStockPacks),
    },
  };
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
            && existing.openingStockPacks === value.openingStockPacks
            && existing.damagedQuantityPacks === value.damagedQuantityPacks
            && existing.closingStockPacks === value.closingStockPacks
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
      const summary = await dailyStockSummary(product._id, value.productionDate, session);
      if (summary.openingStockPacks !== value.openingStockPacks) {
        const unit = product.packType === "Box" ? "boxes" : "cartons";
        const conflict = new Error(`Opening stock changed. Current server opening is ${summary.openingStockPacks} ${unit}; refresh and reconcile the physical count.`);
        conflict.statusCode = 409;
        throw conflict;
      }
      const producedQuantityPacks = calculateProducedPacks({
        closingStockPacks: value.closingStockPacks,
        salesQuantityPacks: summary.salesQuantityPacks,
        damagedQuantityPacks: value.damagedQuantityPacks,
        openingStockPacks: summary.openingStockPacks,
        otherMovementNetPacks: summary.otherMovementNetPacks,
      });
      if (!Number.isInteger(producedQuantityPacks) || producedQuantityPacks < 0) {
        throw conflictError("Calculated production cannot be negative. Check opening, closing, sales, damage, and other stock movements.");
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
      const piecesPerPack = product.piecesPerPack;
      const [run] = await ProductionRun.create([{
        reference,
        productId: product._id,
        productName: product.name,
        productUnit: product.unit,
        recipeId: materializedRecipe?._id ?? null,
        recipeVersion: materializedRecipe?.version ?? null,
        productionDate: value.productionDate,
        inventoryUnit: "pack",
        packTypeSnapshot: product.packType,
        piecesPerPackSnapshot: piecesPerPack,
        openingStockPacks: summary.openingStockPacks,
        salesQuantityPacks: summary.salesQuantityPacks,
        damagedQuantityPacks: value.damagedQuantityPacks,
        closingStockPacks: value.closingStockPacks,
        producedQuantityPacks,
        openingStockPieces: summary.openingStockPacks * piecesPerPack,
        salesQuantityPieces: summary.salesQuantityPacks * piecesPerPack,
        damagedQuantityPieces: value.damagedQuantityPacks * piecesPerPack,
        closingStockPieces: value.closingStockPacks * piecesPerPack,
        producedQuantityPieces: producedQuantityPacks * piecesPerPack,
        damageReason: value.damageReason?.trim() ?? "",
        lines,
        idempotencyKey: value.idempotencyKey,
        actor: actorId(request),
      }], { session });
      const finishedMovementInputs = [
        ...(producedQuantityPacks > 0 ? [{ type: "Production", direction: "in", quantityPacks: producedQuantityPacks, reason: "Calculated daily production" }] : []),
        ...(value.damagedQuantityPacks > 0 ? [{ type: "Damage/write-off", direction: "out", quantityPacks: value.damagedQuantityPacks, reason: value.damageReason.trim() }] : []),
      ];
      for (const movementInput of finishedMovementInputs) {
        await recordFinishedStockMovement({
          ...movementInput,
          productId: product._id,
          packTypeSnapshot: product.packType,
          piecesPerPackSnapshot: piecesPerPack,
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
        details: { productionRunId: String(run._id), reference, productId: String(product._id), producedQuantityPacks, salesQuantityPacks: summary.salesQuantityPacks, packType: product.packType, ingredientCount: 0, rawMaterialUsagePostedSeparately: Boolean(materializedRecipe) },
        transaction: session,
      });
      return { run: serialize(run), balancePacks: await getFinishedBalance(product._id, session) };
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
      balancePacks: finishedMap.get(String(product._id))?.quantityPacks ?? 0,
      reservedPacks: finishedMap.get(String(product._id))?.reservedPacks ?? 0,
      availablePacks: Math.max(0, (finishedMap.get(String(product._id))?.quantityPacks ?? 0) - (finishedMap.get(String(product._id))?.reservedPacks ?? 0)),
      loosePieces: finishedMap.get(String(product._id))?.loosePieces ?? 0,
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
  getDailyProductionStockSummary,
  listRawMovements,
  listStockBalances,
  postProductionMaterialUsage,
  updateProductionMaterialUsage,
  receiveFinishedStock,
  receiveRawMaterial,
  transferRawMaterial,
  updateMaterial,
  deleteMaterial,
  updateProduct,
  validateMaterialInput,
  validatePackagingLevels,
  packagingConversions,
  validateReceiptInput,
  sameRawMaterialReceiptRequest,
  validateIngredients,
  validateProduct,
  calculateProducedPacks,
  calculateProductionMaterialLines,
  calculateProductionUsageStockDeltas,
  validateProductionUsageInput,
  validateProductionUsageUpdateInput,
  validateProductionInput,
};
