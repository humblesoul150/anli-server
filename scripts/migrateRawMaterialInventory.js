require("dotenv").config();
const crypto = require("node:crypto");
const fs = require("node:fs");
const mongoose = require("mongoose");

mongoose.set("autoIndex", false);

const RawMaterial = require("../models/rawMaterial");
const RawMaterialBalance = require("../models/rawMaterialBalance");
const RawMaterialMovement = require("../models/rawMaterialMovement");
const ProductionRecipe = require("../models/productionRecipe");
const User = require("../models/user");
const audit = require("../lib/audit");
const { recordRawMaterialMovement } = require("../lib/productionInventory");

const movementTypes = new Set([
  "Opening balance",
  "Stock in",
  "Receipt",
  "Stock out",
  "Production use",
  "Transfer",
  "Adjustment increase",
  "Adjustment decrease",
]);

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function movementDelta(movement) {
  if (movement.type === "Transfer") return 0;
  return ["Opening balance", "Stock in", "Receipt", "Adjustment increase"].includes(movement.type)
    ? Number(movement.quantity)
    : -Number(movement.quantity);
}

function calculateLegacyReconciliation(material, movements) {
  const defaultLocation = String(material.location || "Main Warehouse").trim();
  const ordered = [...movements].sort((a, b) =>
    a.date.localeCompare(b.date)
      || String(a.recordedAt || "").localeCompare(String(b.recordedAt || ""))
      || String(a.id).localeCompare(String(b.id)));
  const balances = new Map();
  const minimums = new Map();
  const changeAt = (location, delta) => {
    const next = (balances.get(location) || 0) + delta;
    balances.set(location, next);
    minimums.set(location, Math.min(minimums.get(location) ?? 0, next));
  };

  for (const movement of ordered) {
    if (movement.type === "Transfer") {
      changeAt(String(movement.fromLocation).trim(), -Number(movement.quantity));
      changeAt(String(movement.toLocation).trim(), Number(movement.quantity));
    } else if (["Opening balance", "Stock in", "Receipt", "Adjustment increase"].includes(movement.type)) {
      changeAt(String(movement.toLocation || defaultLocation).trim(), Number(movement.quantity));
    } else {
      changeAt(String(movement.fromLocation || defaultLocation).trim(), -Number(movement.quantity));
    }
  }

  const openingBalances = [...minimums.entries()]
    .filter(([, minimum]) => minimum < 0)
    .map(([location, minimum]) => ({ location, quantity: -minimum }));
  const movementNetQuantity = movements.reduce((total, movement) => total + movementDelta(movement), 0);
  const openingTotal = openingBalances.reduce((total, opening) => total + opening.quantity, 0);
  const reconciliationQuantity = Number(material.quantity) - movementNetQuantity - openingTotal;
  if (reconciliationQuantity > 1e-9) {
    const existingOpening = openingBalances.find((opening) => opening.location === defaultLocation);
    if (existingOpening) existingOpening.quantity += reconciliationQuantity;
    else openingBalances.push({ location: defaultLocation, quantity: reconciliationQuantity });
  }
  const closingAdjustments = [];
  if (reconciliationQuantity < -1e-9) {
    let remaining = Math.abs(reconciliationQuantity);
    const available = new Map(balances);
    for (const opening of openingBalances) {
      available.set(opening.location, (available.get(opening.location) || 0) + opening.quantity);
    }
    for (const [location, quantity] of [...available.entries()].sort((a, b) => b[1] - a[1])) {
      const adjustment = Math.min(Math.max(0, quantity), remaining);
      if (adjustment > 1e-9) closingAdjustments.push({ location, quantity: adjustment });
      remaining -= adjustment;
      if (remaining <= 1e-9) break;
    }
    if (remaining > 1e-6) {
      throw new Error(`Cannot reconcile legacy movement history for ${material.code}; the movement ledger would require a negative location balance.`);
    }
  }

  return {
    legacyMaterialId: String(material.id),
    code: normalizeCode(material.code),
    legacyCurrentQuantity: Number(material.quantity),
    movementNetQuantity,
    openingBalances,
    reconciliationQuantity,
    closingAdjustments,
    action: openingBalances.length || closingAdjustments.length ? "add reviewed opening/closing movements" : "none",
  };
}

function inspectMigration(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Migration file must contain a JSON object.");
  }
  const materials = Array.isArray(payload.materials) ? payload.materials : [];
  const movements = Array.isArray(payload.stockMovements) ? payload.stockMovements : [];
  const errors = [];
  const materialIds = new Set();
  const movementIds = new Set();
  const codes = new Set();
  const names = new Set();

  materials.forEach((material, index) => {
    if (!material || typeof material !== "object" || Array.isArray(material)) {
      errors.push(`materials[${index}] must be an object.`);
      return;
    }
    const id = String(material.id || "");
    const code = normalizeCode(material.code);
    if (!id || !code || !material.name || !material.unit) errors.push(`materials[${index}] is missing ID, code, name, or unit.`);
    if (id && materialIds.has(id)) errors.push(`Legacy material ID ${id} appears more than once.`);
    if (id) materialIds.add(id);
    if (code && codes.has(code)) errors.push(`Material code ${code} appears more than once.`);
    if (code) codes.add(code);
    const name = String(material.name || "").trim().toLowerCase();
    if (name && names.has(name)) errors.push(`Material name ${material.name} appears more than once.`);
    if (name) names.add(name);
    if (!Number.isFinite(Number(material.quantity)) || Number(material.quantity) < 0) {
      errors.push(`Material ${code || index} has an invalid current quantity.`);
    }
    if (material.threshold !== undefined && (!Number.isFinite(Number(material.threshold)) || Number(material.threshold) < 0)) {
      errors.push(`Material ${code || index} has an invalid reorder threshold.`);
    }
  });

  movements.forEach((movement, index) => {
    if (!movement || typeof movement !== "object" || Array.isArray(movement)) {
      errors.push(`stockMovements[${index}] must be an object.`);
      return;
    }
    const id = String(movement.id || "");
    const date = typeof movement.date === "string" ? movement.date : "";
    if (!id) errors.push(`stockMovements[${index}] is missing its legacy ID.`);
    if (id && movementIds.has(id)) errors.push(`Legacy movement ID ${id} appears more than once.`);
    if (id) movementIds.add(id);
    if (!materialIds.has(String(movement.materialId))) errors.push(`Movement ${movement.reference || id || index} references an unknown legacy material ID.`);
    if (!movementTypes.has(movement.type)) errors.push(`Movement ${movement.reference || id || index} has unsupported type ${movement.type}.`);
    if (!Number.isFinite(Number(movement.quantity)) || Number(movement.quantity) <= 0) errors.push(`Movement ${movement.reference || id || index} has an invalid quantity.`);
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      errors.push(`Movement ${movement.reference || id || index} has an invalid date.`);
    }
    if (movement.type === "Transfer" && (!movement.fromLocation || !movement.toLocation || movement.fromLocation === movement.toLocation)) {
      errors.push(`Transfer ${movement.reference || id || index} must have different source and destination locations.`);
    }
  });

  const reconciliation = materials.filter((material) => material && typeof material === "object" && !Array.isArray(material)).map((material) =>
    calculateLegacyReconciliation(material, movements.filter((movement) => String(movement.materialId) === String(material.id))))
    .filter((item) => item.openingBalances.length > 0 || item.closingAdjustments.length > 0);

  return {
    errors,
    materialCount: materials.length,
    movementCount: movements.length,
    materials,
    movements,
    reconciliation,
  };
}

async function inspectDatabase(preview) {
  const allMaterials = await RawMaterial.find().select("code name unit").lean();
  const byCode = new Map(allMaterials.map((material) => [normalizeCode(material.code), material]));
  const byName = new Map(allMaterials.map((material) => [String(material.name).trim().toLowerCase(), material]));
  const conflicts = [];
  const matched = [];
  const proposed = [];

  for (const source of preview.materials) {
    const code = normalizeCode(source.code);
    const current = byCode.get(code);
    const sameName = byName.get(String(source.name).trim().toLowerCase());
    if (!current && sameName) {
      conflicts.push({ code, reason: "The name is already assigned to another catalog code.", existingCode: sameName.code });
      continue;
    }
    if (!current) {
      proposed.push(code);
      continue;
    }
    if (String(current.name).trim().toLowerCase() !== String(source.name).trim().toLowerCase() || current.unit !== source.unit) {
      conflicts.push({ code, reason: "Catalog name or unit differs.", existing: { name: current.name, unit: current.unit }, legacy: { name: source.name, unit: source.unit } });
      continue;
    }
    matched.push(code);
    const balances = await RawMaterialBalance.find({ materialId: current._id }).select("location quantity").lean();
    const existingMovements = await RawMaterialMovement.countDocuments({ materialId: current._id });
    if (balances.some((balance) => balance.quantity > 0) || existingMovements > 0) {
      conflicts.push({
        code,
        reason: "The backend already has a non-empty balance or movement history; reconcile it manually before importing legacy history.",
        backendBalances: balances,
        backendMovementCount: existingMovements,
      });
    }
  }

  const duplicateBalance = await RawMaterialBalance.collection.aggregate([
    { $group: { _id: { materialId: "$materialId", location: "$location" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]).next();
  if (duplicateBalance) {
    conflicts.push({
      reason: "Backend contains duplicate material/location balances that must be reconciled before replacing the balance index.",
      key: duplicateBalance._id,
    });
  }

  return { conflicts, matched, proposed };
}

async function ensureBalanceIndexes() {
  const indexes = await RawMaterialBalance.collection.indexes();
  const legacyUniqueIndex = indexes.find((index) =>
    index.unique && Object.keys(index.key || {}).length === 1 && index.key.materialId === 1);
  if (legacyUniqueIndex) await RawMaterialBalance.collection.dropIndex(legacyUniqueIndex.name);

  await RawMaterialBalance.collection.updateMany(
    { $or: [{ location: { $exists: false } }, { location: null }, { location: "" }] },
    { $set: { location: "Main Warehouse" } },
  );
  await RawMaterialBalance.collection.updateMany(
    { reorderThreshold: { $exists: false } },
    { $set: { reorderThreshold: 0 } },
  );
  await RawMaterialBalance.collection.updateMany(
    { responsibleUserId: { $exists: false } },
    { $set: { responsibleUserId: null } },
  );
  const duplicate = await RawMaterialBalance.collection.aggregate([
    { $group: { _id: { materialId: "$materialId", location: "$location" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]).next();
  if (duplicate) throw new Error(`Duplicate material/location balances must be reconciled before index migration: ${JSON.stringify(duplicate._id)}`);
  await RawMaterialBalance.collection.createIndex({ materialId: 1, location: 1 }, { unique: true });
}

async function migrate(payload, actorId, apply, acceptReconciliation = false) {
  const preview = inspectMigration(payload);
  if (preview.errors.length) return { mode: apply ? "blocked" : "dry-run", conflicts: preview.errors };

  const migrationHash = crypto.createHash("sha256")
    .update(JSON.stringify({ materials: preview.materials, stockMovements: preview.movements }))
    .digest("hex");
  const markerCollection = mongoose.connection.collection("rawmaterialmigrations");
  if (apply && await markerCollection.findOne({ _id: migrationHash })) {
    return { mode: "already-applied", migrationId: migrationHash };
  }

  const db = await inspectDatabase(preview);
  const recipeCount = await ProductionRecipe.collection.countDocuments({ "ingredients.quantityPerPiece": { $exists: true } });
  if (!apply) {
    return {
      mode: "dry-run",
      materials: preview.materialCount,
      movements: preview.movementCount,
      proposedNewMaterialCodes: db.proposed,
      existingMaterialCodesMatched: db.matched,
      conflicts: db.conflicts,
      balanceReconciliation: preview.reconciliation,
      legacyRecipesNeedingPerTankField: recipeCount,
      browserLocalRecipesForManualReview: Array.isArray(payload.productionRecipes) ? payload.productionRecipes.length : 0,
      browserLocalProductionRunsForManualReview: Array.isArray(payload.productionRuns) ? payload.productionRuns.length : 0,
      notes: [
        "No data was changed.",
        "Existing backend balances or movement histories are never merged automatically.",
        "Review any balance reconciliation and rerun with --accept-reconciliation to confirm generated opening/closing entries.",
        "Browser-local recipes and production runs are exported for mapping/reconciliation, not imported over server product or historical production records.",
      ],
    };
  }
  if (db.conflicts.length) return { mode: "blocked", conflicts: db.conflicts };
  if (preview.reconciliation.length && !acceptReconciliation) {
    return {
      mode: "blocked",
      conflicts: [{ reason: "Legacy balances differ from movement totals. Review the dry-run reconciliation and rerun with --accept-reconciliation to record the explicit balancing entries.", balanceReconciliation: preview.reconciliation }],
    };
  }
  if (!mongoose.isValidObjectId(actorId)) throw new Error("Pass --actor=<active-user-id> to identify the migration operator.");
  const operator = await User.findOne({
    _id: actorId,
    status: "Active",
    roles: { $in: ["Super Admin", "Admin", "Inventory Manager"] },
  }).lean();
  if (!operator) throw new Error("Migration actor must be an active Super Admin, Admin, or Inventory Manager.");

  await ensureBalanceIndexes();
  const session = await mongoose.startSession();
  let importedMovements = 0;
  let convertedRecipeCount = 0;
  let alreadyApplied = false;
  try {
    await session.withTransaction(async () => {
      const marker = await markerCollection.findOne({ _id: migrationHash }, { session });
      if (marker) {
        alreadyApplied = true;
        return;
      }

      const existingMaterials = await RawMaterial.find({
        code: { $in: preview.materials.map((material) => normalizeCode(material.code)) },
      }).session(session).lean();
      const byCode = new Map(existingMaterials.map((material) => [normalizeCode(material.code), material]));
      const idMap = new Map();
      for (const source of preview.materials) {
        const code = normalizeCode(source.code);
        let material = byCode.get(code);
        if (!material) {
          [material] = await RawMaterial.create([{
            code,
            name: String(source.name).trim(),
            category: String(source.category || "General").trim(),
            unit: String(source.unit).trim(),
            createdBy: operator._id,
            updatedBy: operator._id,
          }], { session });
          byCode.set(code, material);
        }
        idMap.set(String(source.id), { material, source });
        const locations = new Set([String(source.location || "Main Warehouse").trim()]);
        for (const movement of preview.movements.filter((entry) => String(entry.materialId) === String(source.id))) {
          if (movement.fromLocation) locations.add(String(movement.fromLocation).trim());
          if (movement.toLocation) locations.add(String(movement.toLocation).trim());
        }
        for (const location of locations) {
          const balance = await RawMaterialBalance.findOneAndUpdate(
            { materialId: material._id, location },
            {
              $setOnInsert: {
                quantity: 0,
                reorderThreshold: Math.max(0, Number(source.threshold) || 0),
                responsibleUserId: null,
                updatedBy: operator._id,
              },
            },
            { upsert: true, new: true, session, setDefaultsOnInsert: true },
          );
          if (balance.reorderThreshold === 0 && Number(source.threshold) > 0) {
            balance.reorderThreshold = Number(source.threshold);
            balance.updatedBy = operator._id;
            await balance.save({ session });
          }
        }
      }

      const insertMovement = async (input) => {
        if (await RawMaterialMovement.exists({ idempotencyKey: input.idempotencyKey }).session(session)) return;
        await recordRawMaterialMovement(input, session);
        importedMovements += 1;
      };

      const orderedMovements = [...preview.movements].sort((a, b) =>
        a.date.localeCompare(b.date)
          || String(a.recordedAt || "").localeCompare(String(b.recordedAt || ""))
          || String(a.id).localeCompare(String(b.id)));
      for (const { material, source } of idMap.values()) {
        const reconciliation = preview.reconciliation.find((item) => item.legacyMaterialId === String(source.id));
        for (const [index, opening] of (reconciliation?.openingBalances ?? []).entries()) {
          const locationKey = crypto.createHash("sha256").update(opening.location).digest("hex").slice(0, 12);
          await insertMovement({
            materialId: material._id,
            type: "Opening balance",
            direction: "in",
            quantity: opening.quantity,
            date: orderedMovements.find((movement) => String(movement.materialId) === String(source.id))?.date || new Date().toISOString().slice(0, 10),
            reference: `LEGACY-OPEN-${String(source.id).slice(-15)}-${index + 1}`,
            sourceType: "migration",
            idempotencyKey: `legacy-opening:${source.id}:${locationKey}`.slice(0, 120),
            reason: "Opening quantity reconciled from the legacy movement history",
            toLocation: opening.location,
            materialName: material.name,
            unit: material.unit,
            actor: operator._id,
          });
        }
      }

      for (const movement of orderedMovements) {
        const mapped = idMap.get(String(movement.materialId));
        const key = `legacy-movement:${movement.id}`;
        const type = movement.type === "Receipt" ? "Stock in" : movement.type;
        const location = String(mapped.source.location || "Main Warehouse").trim();
        const direction = type === "Transfer"
          ? "transfer"
          : ["Opening balance", "Stock in", "Adjustment increase"].includes(type) ? "in" : "out";
        await insertMovement({
          materialId: mapped.material._id,
          type,
          direction,
          quantity: Number(movement.quantity),
          date: movement.date,
          reference: String(movement.reference || key).slice(0, 80),
          receiptReference: movement.receiptReference || undefined,
          sourceType: "migration",
          idempotencyKey: key.slice(0, 120),
          reason: movement.reason || "Imported from legacy raw-material history",
          fromLocation: movement.fromLocation || (direction === "out" || direction === "transfer" ? location : undefined),
          toLocation: movement.toLocation || (direction === "in" || direction === "transfer" ? location : undefined),
          supplier: movement.supplier || undefined,
          sourceReference: movement.sourceReference || undefined,
          unitCost: movement.unitCost === undefined ? undefined : Number(movement.unitCost),
          materialName: mapped.material.name,
          unit: mapped.material.unit,
          actor: operator._id,
        });
      }

      for (const { material, source } of idMap.values()) {
        const reconciliation = preview.reconciliation.find((item) => item.legacyMaterialId === String(source.id));
        for (const [index, adjustment] of (reconciliation?.closingAdjustments ?? []).entries()) {
          const latestMovementDate = orderedMovements
            .filter((movement) => String(movement.materialId) === String(source.id))
            .reduce((latest, movement) => movement.date > latest ? movement.date : latest, "");
          const today = new Date().toISOString().slice(0, 10);
          await insertMovement({
            materialId: material._id,
            type: "Adjustment decrease",
            direction: "out",
            quantity: adjustment.quantity,
            date: latestMovementDate > today ? latestMovementDate : today,
            reference: `LEGACY-ADJ-${String(source.id).slice(-15)}-${index + 1}`,
            sourceType: "migration",
            idempotencyKey: `legacy-reconcile:${source.id}:${crypto.createHash("sha256").update(adjustment.location).digest("hex").slice(0, 12)}`.slice(0, 120),
            reason: "Closing adjustment reconciled to the legacy current balance",
            fromLocation: adjustment.location,
            materialName: material.name,
            unit: material.unit,
            actor: operator._id,
          });
        }
        const balances = await RawMaterialBalance.find({ materialId: material._id }).session(session).lean();
        const currentQuantity = balances.reduce((total, balance) => total + balance.quantity, 0);
        if (Math.abs(currentQuantity - Number(source.quantity)) > 1e-6) {
          throw new Error(`Imported balance for ${material.code} does not reconcile to its exported quantity.`);
        }
      }

      const legacyRecipes = await ProductionRecipe.collection.find(
        { "ingredients.quantityPerPiece": { $exists: true } },
        { session },
      ).toArray();
      for (const recipe of legacyRecipes) {
        const ingredients = recipe.ingredients.map((ingredient) => {
          if (ingredient.quantityPerTank !== undefined) return ingredient;
          const { quantityPerPiece, ...rest } = ingredient;
          return { ...rest, quantityPerTank: quantityPerPiece };
        });
        await ProductionRecipe.collection.updateOne(
          { _id: recipe._id },
          { $set: { ingredients, tankVolumeLitres: 1000 } },
          { session },
        );
      }
      convertedRecipeCount = legacyRecipes.length;

      await audit.recordAudit({
        actor: operator,
        eventType: "inventory.raw_materials_migrated",
        outcome: "success",
        details: { materialCount: idMap.size, importedMovements, convertedRecipeCount },
        transaction: session,
      });
      await markerCollection.insertOne({
        _id: migrationHash,
        actorId: operator._id,
        materialCount: idMap.size,
        importedMovements,
        convertedRecipeCount,
        createdAt: new Date(),
      }, { session });
    });
  } finally {
    await session.endSession();
  }
  return alreadyApplied
    ? { mode: "already-applied", migrationId: migrationHash }
    : { mode: "applied", materialCount: preview.materialCount, importedMovements, convertedRecipeCount };
}

async function main() {
  const [, , filePath, ...args] = process.argv;
  if (!filePath) {
    throw new Error("Usage: node scripts/migrateRawMaterialInventory.js <export.json> [--apply] [--accept-reconciliation] [--actor=<user-id>]");
  }
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const apply = args.includes("--apply");
  const acceptReconciliation = args.includes("--accept-reconciliation");
  const actorArg = args.find((arg) => arg.startsWith("--actor="));
  const actorId = actorArg ? actorArg.slice("--actor=".length) : undefined;
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  await mongoose.connect(process.env.DB_URL);
  try {
    const report = await migrate(payload, actorId, apply, acceptReconciliation);
    console.log(JSON.stringify(report, null, 2));
    if (report.conflicts?.length) process.exitCode = 2;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { inspectMigration, migrate };
