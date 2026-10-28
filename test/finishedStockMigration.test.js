const assert = require("node:assert/strict");
const { test } = require("node:test");
const FinishedProduct = require("../models/finishedProduct");
const FinishedStockBalance = require("../models/finishedStockBalance");
const FinishedStockMovement = require("../models/finishedStockMovement");
const { buildMigrationPlan } = require("../scripts/migrateFinishedStockToPacks");

async function withMigrationData({ products, balances, hasMovements = false }, run) {
  const originals = {
    productFind: FinishedProduct.find,
    balanceFind: FinishedStockBalance.find,
    movementExists: FinishedStockMovement.exists,
  };
  FinishedProduct.find = () => ({ sort: () => ({ lean: async () => products }) });
  FinishedStockBalance.find = () => ({ lean: async () => balances });
  FinishedStockMovement.exists = async () => hasMovements;
  try {
    await run();
  } finally {
    FinishedProduct.find = originals.productFind;
    FinishedStockBalance.find = originals.balanceFind;
    FinishedStockMovement.exists = originals.movementExists;
  }
}

test("finished-stock migration preserves whole packs, reservations, and loose pieces", async () => {
  const productId = "507f1f77bcf86cd799439011";
  await withMigrationData({
    products: [{
      _id: productId,
      name: "Mango juice",
      packType: "Box",
      piecesPerPack: 12,
      packWeightKg: 1.8,
    }],
    balances: [{
      productId,
      quantityPieces: 29,
      reservedPieces: 12,
    }],
  }, async () => {
    const [item] = await buildMigrationPlan();
    assert.equal(item.status, "ready");
    assert.equal(item.quantityPacks, 2);
    assert.equal(item.reservedPacks, 1);
    assert.equal(item.loosePieces, 5);
  });
});

test("finished-stock migration blocks products without valid packaging even with zero stock", async () => {
  const productId = "507f1f77bcf86cd799439012";
  await withMigrationData({
    products: [{ _id: productId, name: "Unconfigured product" }],
    balances: [{ productId, quantityPieces: 0, reservedPieces: 0 }],
  }, async () => {
    const [item] = await buildMigrationPlan();
    assert.equal(item.status, "blocked");
    assert.deepEqual(item.blockers, [
      "product needs a configured box or carton, pieces per pack, and pack weight",
    ]);
  });
});

test("finished-stock migration blocks reservations that cannot convert to whole packs", async () => {
  const productId = "507f1f77bcf86cd799439013";
  await withMigrationData({
    products: [{
      _id: productId,
      name: "Mango juice",
      packType: "Box",
      piecesPerPack: 12,
      packWeightKg: 1.8,
    }],
    balances: [{ productId, quantityPieces: 29, reservedPieces: 5 }],
  }, async () => {
    const [item] = await buildMigrationPlan();
    assert.equal(item.status, "blocked");
    assert.deepEqual(item.blockers, ["reserved pieces are not a whole number of current packs"]);
  });
});
