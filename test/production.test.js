const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const FinishedProduct = require("../models/finishedProduct");
const FinishedStockBalance = require("../models/finishedStockBalance");
const ProductionRecipe = require("../models/productionRecipe");
const ProductionRun = require("../models/productionRun");
const RawMaterialBalance = require("../models/rawMaterialBalance");
const audit = require("../lib/audit");
const productionRouter = require("../routes/production");
const {
  validateIngredients,
  validateProduct,
  validateProductionInput,
  calculateProductionMaterialLines,
  validateProductionUsageInput,
} = require("../controllers/productionController");

const userId = "507f1f77bcf86cd799439011";
const materialId = "507f1f77bcf86cd799439012";
const productId = "507f1f77bcf86cd799439013";

function productInput(overrides = {}) {
  return {
    code: "JU-MAN-01",
    name: "Mango juice",
    category: "Bottle",
    unit: "150 ml",
    flavour: "Mango",
    price: 24000,
    recipeRequired: false,
    ...overrides,
  };
}

test("production product validation accepts optional packaging and rejects partial or invalid packs", () => {
  assert.equal(validateProduct(productInput()).error, undefined);
  assert.equal(validateProduct(productInput()).value.price, 24000);
  assert.match(validateProduct(productInput({ price: 0 })).error, /positive whole number of UGX per pack/);
  assert.match(validateProduct(productInput({ price: 1250.5 })).error, /positive whole number of UGX per pack/);
  assert.match(validateProduct({ ...productInput(), price: undefined }).error, /positive whole number of UGX per pack/);
  assert.equal(validateProduct({ price: 1250 }, true).value.price, 1250);
  assert.equal(validateProduct({}, true).error, undefined);
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
  assert.match(validateProductionUsageInput({ productionRunId: productId, tanksProduced: 0 }).error, /positive/);
});

test("daily production validation calculates production without manual sales dispatch", () => {
  const input = validateProductionInput({
    productId,
    productionDate: "2026-10-21",
    openingStockPieces: 100,
    salesQuantityPieces: 30,
    damagedQuantityPieces: 2,
    closingStockPieces: 18,
    damageReason: "Damaged seals",
  });
  assert.match(input.error, /recorded through the Sales feature/);

  const validInput = {
    productId,
    productionDate: "2026-10-21",
    openingStockPieces: 100,
    damagedQuantityPieces: 2,
    closingStockPieces: 108,
    damageReason: "Damaged seals",
  };
  const valid = validateProductionInput(validInput);
  assert.equal(valid.value.producedQuantityPieces, 10);
  assert.equal(valid.value.salesQuantityPieces, 0);
  assert.match(validateProductionInput({ ...validInput, closingStockPieces: 18 }).error, /cannot be negative/);
  assert.match(validateProductionInput({ ...validInput, productionDate: "2026-02-30" }).error, /valid YYYY-MM-DD/);
  assert.match(validateProductionInput({ ...validInput, damagedQuantityPieces: 1, damageReason: "" }).error, /damage reason/);
  assert.match(validateProductionInput({ ...validInput, closingStockPieces: 108.5 }).error, /whole number of pieces/);
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

  const product = new FinishedProduct({
    ...productInput({ packType: "Box", piecesPerPack: 12 }),
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
