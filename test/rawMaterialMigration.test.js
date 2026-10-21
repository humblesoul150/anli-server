const assert = require("node:assert/strict");
const { test } = require("node:test");
const { inspectMigration } = require("../scripts/migrateRawMaterialInventory");

const materialId = "legacy-material-1";

function exportPayload(overrides = {}) {
  return {
    formatVersion: 1,
    materials: [{
      id: materialId,
      code: "RM-SUGAR",
      name: "Sugar",
      category: "Ingredient",
      quantity: 120,
      unit: "kg",
      threshold: 25,
      location: "Main Warehouse",
    }],
    stockMovements: [
      { id: "move-1", materialId, type: "Stock in", quantity: 100, date: "2026-05-01", reference: "RCV-1" },
      { id: "move-2", materialId, type: "Stock out", quantity: 20, date: "2026-05-02", reference: "USE-1" },
    ],
    ...overrides,
  };
}

test("legacy inventory inspection computes explicit current-balance reconciliation", () => {
  const report = inspectMigration(exportPayload());
  assert.deepEqual(report.errors, []);
  assert.equal(report.materialCount, 1);
  assert.equal(report.movementCount, 2);
  assert.deepEqual(report.reconciliation, [{
    legacyMaterialId: materialId,
    code: "RM-SUGAR",
    legacyCurrentQuantity: 120,
    movementNetQuantity: 80,
    openingBalances: [{ location: "Main Warehouse", quantity: 40 }],
    reconciliationQuantity: 40,
    closingAdjustments: [],
    action: "add reviewed opening/closing movements",
  }]);
});

test("legacy transfer does not change the total material balance", () => {
  const payload = exportPayload({
    materials: [{ ...exportPayload().materials[0], quantity: 100 }],
    stockMovements: [
      { id: "move-1", materialId, type: "Stock in", quantity: 100, date: "2026-05-01", reference: "RCV-1" },
      { id: "move-2", materialId, type: "Transfer", quantity: 20, date: "2026-05-02", reference: "TR-1", fromLocation: "Main Warehouse", toLocation: "Line Store" },
    ],
  });
  const report = inspectMigration(payload);
  assert.deepEqual(report.errors, []);
  assert.equal(report.reconciliation.length, 0);
});

test("legacy transfers report missing opening stock at the source location", () => {
  const report = inspectMigration(exportPayload({
    materials: [{ ...exportPayload().materials[0], quantity: 5 }],
    stockMovements: [
      { id: "move-1", materialId, type: "Transfer", quantity: 5, date: "2026-05-01", reference: "TR-1", fromLocation: "Old Store", toLocation: "Main Warehouse" },
    ],
  }));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.reconciliation[0].openingBalances, [{ location: "Old Store", quantity: 5 }]);
  assert.deepEqual(report.reconciliation[0].closingAdjustments, []);
});

test("legacy migration rejects ambiguous material codes and incomplete transfers", () => {
  const duplicate = exportPayload({
    materials: [
      ...exportPayload().materials,
      { ...exportPayload().materials[0], id: "legacy-material-2" },
    ],
  });
  assert.match(inspectMigration(duplicate).errors.join(" "), /code RM-SUGAR appears more than once/);

  const incompleteTransfer = exportPayload({
    stockMovements: [
      { id: "move-3", materialId, type: "Transfer", quantity: 2, date: "2026-05-02", reference: "TR-1" },
    ],
  });
  assert.match(inspectMigration(incompleteTransfer).errors.join(" "), /different source and destination locations/);
});
