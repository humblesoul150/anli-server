const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const FinishedProduct = require("../models/finishedProduct");
const FinishedStockBalance = require("../models/finishedStockBalance");
const FinishedStockMovement = require("../models/finishedStockMovement");
const ProductionRecipe = require("../models/productionRecipe");
const ProductionRun = require("../models/productionRun");
const RawMaterialBalance = require("../models/rawMaterialBalance");
const audit = require("../lib/audit");
const productionRouter = require("../routes/production");
const {
  validateIngredients,
  validateProduct,
  calculateProducedPacks,
  validateMaterialInput,
  validatePackagingLevels,
  packagingConversions,
  validateReceiptInput,
  sameRawMaterialReceiptRequest,
  validateProductionInput,
  calculateProductionMaterialLines,
  calculateProductionUsageStockDeltas,
  validateProductionUsageInput,
  validateProductionUsageUpdateInput,
} = require("../controllers/productionController");
const RawMaterial = require("../models/rawMaterial");
const RawMaterialMovement = require("../models/rawMaterialMovement");
const ProductionMaterialUsage = require("../models/productionMaterialUsage");
const { AUDIT_EVENT_TYPES } = require("../models/auditEvent");
const { nextKampalaDate } = require("../scripts/migrateFinishedStockToPacks");

const userId = "507f1f77bcf86cd799439011";
const materialId = "507f1f77bcf86cd799439012";
const productId = "507f1f77bcf86cd799439013";
const workDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Kampala",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

function productInput(overrides = {}) {
  return {
    code: "JU-MAN-01",
    name: "Mango juice",
    category: "Bottle",
    unit: "150 ml",
    flavour: "Mango",
    packType: "Box",
    piecesPerPack: 12,
    packWeightKg: 1.8,
    price: 24000,
    recipeRequired: false,
    ...overrides,
  };
}

test("production product validation requires exactly one supported sellable pack and rejects invalid sizes", () => {
  assert.equal(validateProduct(productInput()).error, undefined);
  assert.equal(validateProduct(productInput()).value.price, 24000);
  assert.match(validateProduct(productInput({
    packType: undefined,
    piecesPerPack: undefined,
    packWeightKg: undefined,
  })).error, /must have one configured box or carton/);
  assert.match(validateProduct(productInput({ price: 0 })).error, /positive whole number of UGX per pack/);
  assert.match(validateProduct(productInput({ price: 1250.5 })).error, /positive whole number of UGX per pack/);
  assert.match(validateProduct({ ...productInput(), price: undefined }).error, /positive whole number of UGX per pack/);
  assert.equal(validateProduct({ price: 1250 }, true).value.price, 1250);
  assert.equal(validateProduct({}, true).error, undefined);
  assert.match(validateProduct({ packType: "" }, true).error, /must have one configured box or carton/);
  assert.equal(validateProduct(productInput({
    packType: "Carton",
    piecesPerPack: 24,
    packWeightKg: 4.8,
  })).value.packWeightKg, 4.8);
  assert.match(validateProduct(productInput({ packType: "Box", piecesPerPack: 0, packWeightKg: 2 })).error, /positive whole number/);
  assert.match(validateProduct(productInput({ packType: "Box", piecesPerPack: 12, packWeightKg: -1 })).error, /positive number/);
  assert.match(validateProduct(productInput({ packType: "Pallet" })).error, /Box or Carton/);
  assert.match(validateProduct({ ...productInput(), unexpected: true }).error, /supported request shape/);
});

test("raw-material packaging validates sack and nested box conversions", () => {
  const sack = validateMaterialInput({
    code: "FLOUR",
    name: "Flour",
    category: "Ingredients",
    unit: "kg",
    packagingLevels: [{ name: "sack", quantity: 50 }],
  });
  assert.equal(sack.error, undefined);
  assert.deepEqual(sack.value.packagingLevels, [{ name: "sack", quantity: 50 }]);

  const nested = validateMaterialInput({
    code: "POWDER",
    name: "Powder",
    category: "Ingredients",
    unit: "kg",
    packagingLevels: [
      { name: "sachet", quantity: 1 },
      { name: "box", quantity: 20 },
    ],
  });
  assert.equal(nested.error, undefined);
  assert.deepEqual(packagingConversions({ ...nested.value }), [
    { name: "sachet", baseUnitsPerPackage: 1 },
    { name: "box", baseUnitsPerPackage: 20 },
  ]);
  assert.match(validatePackagingLevels([
    { name: "sachet", quantity: 1 },
    { name: "box", quantity: 2.5 },
  ], "kg").error, /whole numbers/);
  assert.match(validatePackagingLevels([
    { name: "box", quantity: 1 },
    { name: "BOX", quantity: 2 },
  ], "kg").error, /unique/);
  assert.match(validatePackagingLevels([{ name: "kg", quantity: 5 }], "kg").error, /different from the base unit/);
  assert.match(validateMaterialInput({
    code: "BAD",
    name: "Bad",
    unit: "kg",
    packagingLevels: [{ name: "sack", quantity: 0 }],
  }).error, /positive finite numbers/);
});

test("raw-material package receipts convert to base units and snapshot entered package data", () => {
  const material = {
    unit: "kg",
    packagingLevels: [
      { name: "sachet", quantity: 1 },
      { name: "box", quantity: 20 },
    ],
  };
  const receipt = validateReceiptInput({
    date: "2026-10-28",
    reason: "Supplier delivery",
    packageUnit: "box",
    packageQuantity: 3,
    packagePrice: 240000,
  }, material);
  assert.equal(receipt.error, undefined);
  assert.deepEqual(receipt.value, {
    quantity: 60,
    unitCost: 12000,
    receiptPackaging: {
      packageQuantity: 3,
      packageUnit: "box",
      baseUnitsPerPackage: 20,
      packagePrice: 240000,
    },
  });
  assert.match(validateReceiptInput({
    date: "2026-10-28",
    reason: "Invalid package",
    packageUnit: "carton",
    packageQuantity: 1,
    packagePrice: 100,
  }, material).error, /configured/);
  assert.match(validateReceiptInput({
    date: "2026-10-28",
    reason: "Missing package details",
    quantity: 60,
    unitCost: 12000,
  }, material).error, /Select a configured package unit/);

  const legacy = validateReceiptInput({
    date: "2026-10-28",
    reason: "Legacy receipt",
    quantity: 2.5,
    unitCost: 500,
  }, { unit: "kg", packagingLevels: [] });
  assert.equal(legacy.error, undefined);
  assert.equal(legacy.value.quantity, 2.5);
  assert.equal(legacy.value.unitCost, 500);
  assert.equal(legacy.value.receiptPackaging, undefined);
  const legacyPackageInput = validateReceiptInput({
    date: "2026-10-28",
    reason: "Base-unit package input",
    packageUnit: "kg",
    packageQuantity: 2,
    packagePrice: 1000,
  }, { unit: "kg", packagingLevels: [] });
  assert.equal(legacyPackageInput.error, undefined);
  assert.equal(legacyPackageInput.value.quantity, 2);
  assert.equal(legacyPackageInput.value.unitCost, 1000);
  assert.equal(legacyPackageInput.value.receiptPackaging.baseUnitsPerPackage, 1);
  assert.match(validateReceiptInput({
    date: "2026-10-28",
    reason: "Ambiguous quantity",
    quantity: 2,
    unitCost: 500,
    packageUnit: "kg",
    packageQuantity: 2,
    packagePrice: 1000,
  }, { unit: "kg", packagingLevels: [] }).error, /not base-unit quantity or unit cost/);

  const savedReceipt = {
    materialId,
    type: "Stock in",
    quantity: 60,
    date: "2026-10-28",
    reason: "Supplier delivery",
    toLocation: "Main Warehouse",
    receiptReference: "INV-20",
    supplier: "Supplier",
    sourceReference: "DEL-1",
    receiptPackaging: receipt.value.receiptPackaging,
    unitCost: receipt.value.unitCost,
  };
  const request = {
    materialId,
    quantity: 60,
    date: "2026-10-28",
    reason: "Supplier delivery",
    destination: "Main Warehouse",
    reference: "INV-20",
    supplier: "Supplier",
    sourceReference: "DEL-1",
    receiptPackaging: receipt.value.receiptPackaging,
    unitCost: receipt.value.unitCost,
  };
  assert.equal(sameRawMaterialReceiptRequest(savedReceipt, request), true);
  assert.equal(sameRawMaterialReceiptRequest(savedReceipt, {
    ...request,
    receiptPackaging: { ...request.receiptPackaging, packagePrice: 240001 },
  }), false);
  assert.equal(sameRawMaterialReceiptRequest(savedReceipt, {
    ...request,
    receiptPackaging: { ...request.receiptPackaging, packageUnit: "sachet" },
  }), false);

  assert.ok(RawMaterial.schema.path("packagingLevels"));
  assert.ok(RawMaterialMovement.schema.path("receiptPackaging"));
});

test("product recipe validation uses shared materials and per-1,000-litre tank quantities", () => {
  const selected = validateIngredients([
    { materialId, quantityPerTank: 25 },
    { materialId: "507f1f77bcf86cd799439014", quantityPerTank: 100 },
  ]);
  assert.equal(selected.error, undefined);
  assert.equal(selected.value.length, 2);
  assert.equal(selected.value[0].quantityPerTank, 25);

  assert.match(validateIngredients([{ materialId, quantityPerTank: 1 }, { materialId, quantityPerTank: 2 }]).error, /only once/);
  assert.match(validateIngredients([{ materialId, quantityPerTank: 0 }]).error, /positive number/);
  assert.match(validateIngredients([{ materialId, quantityPerTank: 1, extra: true }]).error, /unsupported fields/);
  assert.match(validateIngredients([{ materialId, quantityPerPiece: 1 }]).error, /unsupported fields/);
  assert.equal(validateIngredients([], true).error, undefined);
});

test("daily tank-use calculation multiplies each recipe amount by tanks produced", () => {
  const lines = calculateProductionMaterialLines([
    { materialId, materialName: "Sugar", unit: "kg", quantityPerTank: 20 },
    { materialId: "507f1f77bcf86cd799439014", materialName: "Water", unit: "L", quantityPerTank: 800 },
  ], 22);
  assert.deepEqual(lines.map((line) => line.totalQuantity), [440, 17600]);
  assert.deepEqual(calculateProductionUsageStockDeltas([
    { materialId, materialName: "Sugar", unit: "kg", totalQuantity: 40 },
  ], "Store A", [
    { materialId, materialName: "Sugar", unit: "kg", totalQuantity: 55 },
  ], "Store A"), [{
    materialId,
    materialName: "Sugar",
    unit: "kg",
    location: "Store A",
    delta: -15,
  }]);
  assert.deepEqual(calculateProductionUsageStockDeltas([
    { materialId, materialName: "Sugar", unit: "kg", totalQuantity: 40 },
  ], "Store A", [
    { materialId: "507f1f77bcf86cd799439014", materialName: "Salt", unit: "kg", totalQuantity: 8 },
  ], "Store B"), [
    { materialId, materialName: "Sugar", unit: "kg", location: "Store A", delta: 40 },
    { materialId: "507f1f77bcf86cd799439014", materialName: "Salt", unit: "kg", location: "Store B", delta: -8 },
  ]);
  assert.match(validateProductionUsageInput({ productionRunId: productId, tanksProduced: 0 }).error, /positive/);
  assert.deepEqual(validateProductionUsageInput({
    productId,
    productionDate: "2026-10-28",
    tanksProduced: 2,
    location: "Main Warehouse",
    idempotencyKey: "material-use-key",
  }).value, {
    productionRunId: undefined,
    productId,
    productionDate: "2026-10-28",
    tanksProduced: 2,
    location: "Main Warehouse",
    idempotencyKey: "material-use-key",
  });
  assert.match(validateProductionUsageInput({
    productId,
    productionDate: "2026-02-30",
    tanksProduced: 2,
    location: "Main Warehouse",
  }).error, /product and production date/);
  assert.match(validateProductionUsageInput({
    productId,
    productionDate: "2026-10-28",
    tanksProduced: 2,
    location: "Main Warehouse",
  }).error, /idempotency key/);
  assert.match(validateProductionUsageInput({
    productId,
    productionRunId: productId,
    productionDate: "2026-10-28",
    tanksProduced: 2,
    location: "Main Warehouse",
  }).error, /product and production date/);
  assert.deepEqual(validateProductionUsageUpdateInput({
    productId,
    productionDate: "2026-10-28",
    tanksProduced: 1.5,
    location: "Main Warehouse",
  }).value, {
    productId,
    productionDate: "2026-10-28",
    tanksProduced: 1.5,
    location: "Main Warehouse",
  });
  assert.match(validateProductionUsageUpdateInput({
    productId,
    productionDate: "2026-02-30",
    tanksProduced: 2,
    location: "Main Warehouse",
  }).error, /valid product/);
  assert.match(validateProductionUsageUpdateInput({
    productId,
    productionDate: "2026-10-28",
    tanksProduced: 0,
    location: "Main Warehouse",
  }).error, /valid product/);
});

test("daily production validation accepts pack counts and rejects piece-based requests", () => {
  const validInput = {
    productId,
    productionDate: workDate,
    openingStockPacks: 100,
    damagedQuantityPacks: 2,
    closingStockPacks: 108,
    damageReason: "Damaged seals",
  };
  const valid = validateProductionInput(validInput);
  assert.equal(valid.error, undefined);
  assert.equal(valid.value.openingStockPacks, 100);
  assert.equal(valid.value.damagedQuantityPacks, 2);
  assert.match(validateProductionInput({
    ...validInput,
    openingStockPieces: 100,
  }).error, /unsupported fields/);
  assert.match(validateProductionInput({ ...validInput, productionDate: "2026-02-30" }).error, /valid YYYY-MM-DD/);
  assert.match(validateProductionInput({ ...validInput, damagedQuantityPacks: 1, damageReason: "" }).error, /damage reason/);
  assert.match(validateProductionInput({ ...validInput, closingStockPacks: 108.5 }).error, /whole number of boxes or cartons/);
});

test("daily production reconciliation derives packs from sales and other stock movements", () => {
  assert.equal(calculateProducedPacks({
    openingStockPacks: 20,
    salesQuantityPacks: 4,
    damagedQuantityPacks: 2,
    closingStockPacks: 15,
    otherMovementNetPacks: -1,
  }), 2);
  assert.equal(calculateProducedPacks({
    openingStockPacks: 20,
    salesQuantityPacks: 4,
    damagedQuantityPacks: 2,
    closingStockPacks: 25,
    otherMovementNetPacks: 5,
  }), 6);
});

test("finished stock schemas preserve pack snapshots and legacy piece history", async () => {
  const balance = new FinishedStockBalance({
    productId,
    inventoryUnit: "pack",
    quantityPacks: 7,
    reservedPacks: 2,
    loosePieces: 5,
    openingQuantityPacks: 7,
    inventoryEffectiveDate: "2026-10-29",
    updatedBy: userId,
  });
  await balance.validate();
  assert.equal(balance.quantityPacks - balance.reservedPacks, 5);
  assert.equal(balance.loosePieces, 5);

  const movement = new FinishedStockMovement({
    productId,
    type: "Sales dispatch",
    direction: "out",
    inventoryUnit: "pack",
    quantityPacks: 1,
    packTypeSnapshot: "Box",
    piecesPerPackSnapshot: 12,
    quantityPieces: 12,
    date: "2026-10-29",
    reference: "SAL-2026-000001",
    sourceType: "sale",
    productName: "Mango juice",
    actor: userId,
  });
  await movement.validate();
  assert.equal(movement.quantityPacks, 1);
  assert.equal(movement.quantityPieces, 12);

  const legacyMovement = new FinishedStockMovement({
    productId,
    type: "Opening balance",
    direction: "in",
    quantityPieces: 15,
    date: "2026-10-28",
    reference: "OPEN-1",
    sourceType: "opening",
    productName: "Mango juice",
    actor: userId,
  });
  await legacyMovement.validate();
  assert.equal(legacyMovement.inventoryUnit, "piece_legacy");
  assert.equal(nextKampalaDate(new Date("2026-10-28T20:00:00.000Z")), "2026-10-29");
});

test("production schemas index product identity, daily uniqueness, recipes, and inventory balances", async () => {
  const codeIndex = FinishedProduct.schema.indexes().find(([keys]) => keys.code === 1);
  assert.equal(codeIndex[1].unique, true);
  assert.ok(ProductionRun.schema.indexes().some(([keys, options]) =>
    keys.productId === 1 && keys.productionDate === 1 && options.unique === true,
  ));
  assert.ok(ProductionRecipe.schema.indexes().some(([keys, options]) =>
    keys.productId === 1 && keys.version === 1 && options.unique === true,
  ));
  assert.ok(FinishedStockBalance.schema.indexes().some(([keys, options]) => keys.productId === 1 && options.unique === true));
  assert.ok(RawMaterialBalance.schema.indexes().some(([keys, options]) => keys.materialId === 1 && options.unique === true));
  assert.notEqual(ProductionMaterialUsage.schema.path("productionRunId").isRequired, true);
  assert.ok(ProductionMaterialUsage.schema.indexes().some(([keys, options]) =>
    keys.productionRunId === 1 && options.unique === true && options.sparse === true,
  ));
  const directUsage = new ProductionMaterialUsage({
    reference: "USE-DIRECT-001",
    productId,
    productName: "Mango juice",
    productionDate: "2026-10-28",
    tanksProduced: 2,
    tankVolumeLitres: 1000,
    location: "Main Warehouse",
    recipeId: new mongoose.Types.ObjectId(),
    recipeVersion: 1,
    lines: [{
      materialId,
      materialName: "Sugar",
      unit: "kg",
      quantityPerTank: 20,
      totalQuantity: 40,
    }],
    idempotencyKey: "direct-usage-key",
    actor: userId,
  });
  await directUsage.validate();
  assert.equal(directUsage.productionRunId, undefined);

  const product = new FinishedProduct({
    ...productInput({ packType: "Box", piecesPerPack: 12, packWeightKg: undefined }),
    createdBy: userId,
    updatedBy: userId,
  });
  await assert.rejects(product.validate(), /Pack type requires/);
  const validProduct = new FinishedProduct({
    ...productInput({ packType: "Box", piecesPerPack: 12, packWeightKg: 1.8 }),
    createdBy: userId,
    updatedBy: userId,
  });
  await validProduct.validate();
  assert.equal(validProduct.price, 24000);
  await assert.rejects(new FinishedProduct({
    ...productInput({ price: 0 }),
    createdBy: userId,
    updatedBy: userId,
  }).validate(), /less than minimum allowed/);

  const recipe = new ProductionRecipe({
    productId,
    version: 1,
    ingredients: [{ materialId, materialName: "Sugar", unit: "kg", quantityPerTank: 20 }],
    createdBy: userId,
  });
  await recipe.validate();
  const run = new ProductionRun({
    reference: "PROD-001",
    productId,
    productName: "Mango juice",
    productUnit: "150 ml",
    productionDate: "2026-10-21",
    openingStockPieces: 0,
    salesQuantityPieces: 0,
    damagedQuantityPieces: 0,
    closingStockPieces: 12,
    producedQuantityPieces: 12,
    actor: userId,
  });
  await run.validate();
  assert.equal(mongoose.isValidObjectId(run.productId), true);
});

test("production route roles permit production managers and audit denied roles", async () => {
  const originalAudit = audit.recordAudit;
  const events = [];
  audit.recordAudit = async (event) => events.push(event);
  try {
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await productionRouter.requireProductionWriter(
      { authUser: { roles: ["Production Manager"] } },
      { status() { return this; }, json(body) { this.body = body; return this; } },
      next,
    );
    assert.equal(nextCalled, true);

    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await productionRouter.requireProductionWriter(
      { authUser: { roles: ["Accountant"] }, baseUrl: "/api/production" },
      response,
      () => assert.fail("Unauthorized user must not continue."),
    );
    assert.equal(response.statusCode, 403);
    assert.equal(events[0].reason, "production_role_required");
  } finally {
    audit.recordAudit = originalAudit;
  }
});

test("raw-material profile mutation routes are role-protected and have audit event types", () => {
  const mutations = productionRouter.stack
    .filter((layer) => layer.route?.path === "/materials/:materialId")
    .map((layer) => Object.keys(layer.route.methods));
  assert.deepEqual(mutations, [["patch"], ["delete"]]);
  assert.ok(AUDIT_EVENT_TYPES.includes("production.material_updated"));
  assert.ok(AUDIT_EVENT_TYPES.includes("production.material_deleted"));
});

test("production usage edits are writer-protected and auditable", () => {
  const route = productionRouter.stack.find((layer) => layer.route?.path === "/materials/production-usages/:id");
  assert.deepEqual(Object.keys(route.route.methods), ["patch"]);
  assert.ok(AUDIT_EVENT_TYPES.includes("inventory.production_material_usage_updated"));
});
