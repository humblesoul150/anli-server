const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createDashboardSummary,
  isValidDateString,
  permittedSections,
  resolveRange,
} = require("../lib/dashboardSummary");

test("validates dates and bounds dashboard ranges", () => {
  assert.equal(isValidDateString("2024-02-29"), true);
  assert.equal(isValidDateString("2025-02-29"), false);
  assert.equal(isValidDateString(["2025-01-01"]), false);
  assert.deepEqual(resolveRange("2025-01-01", "2025-01-31"), {
    from: "2025-01-01",
    to: "2025-01-31",
  });
  assert.throws(() => resolveRange("2025-02-02", "2025-02-01"), { statusCode: 400 });
  assert.throws(() => resolveRange("2024-01-01", "2025-01-01"), { statusCode: 400 });
});

test("returns only the sections granted by a user's department roles", () => {
  assert.deepEqual(permittedSections(["Sales Manager"]), ["sales", "orders"]);
  assert.deepEqual(
    permittedSections(["General Manager"]),
    ["sales", "orders", "production", "inventory", "expenses", "assets"],
  );
  assert.deepEqual(permittedSections(["Human Resource"]), ["people"]);
});

test("builds role-scoped summary aggregates without returning source records", async () => {
  const logger = { error() { assert.fail("unexpected aggregate error"); } };
  const models = {
    Sale: {
      aggregate: async (pipeline) => pipeline.some((stage) => stage.$unwind)
        ? [{ _id: "Flour", revenue: 120 }]
        : pipeline.some((stage) => stage.$group?._id === null)
          ? [{ _id: null, total: 1000, paid: 800 }]
          : [{ _id: "2025-01-01", revenue: 200 }],
      countDocuments: async () => 2,
    },
    SalePayment: { aggregate: async () => [{ _id: "2025-01-01", collected: 150 }] },
    Order: {
      aggregate: async () => [{ _id: "Pending", count: 3 }, { _id: "Completed", count: 2 }],
      countDocuments: async () => 1,
    },
    ProductionRun: {
      aggregate: async () => [{ _id: "2025-01-01", produced: 20, damaged: 1 }],
    },
    RawMaterialAlert: { countDocuments: async () => 4 },
    Expense: {
      aggregate: async () => [{ _id: "2025-01-01", amount: 100 }],
      countDocuments: async () => 2,
    },
    AttendanceRecord: { aggregate: async () => [{ _id: "Present", count: 8 }] },
    LeaveRequest: { countDocuments: async () => 1 },
    CompanyAsset: { countDocuments: async () => 3 },
  };
  const getSummary = createDashboardSummary(models, logger);
  const result = await getSummary({
    roles: ["General Manager"],
    from: "2025-01-01",
    to: "2025-01-07",
  });

  assert.equal(result.sections.sales.revenue, 200);
  assert.equal(result.sections.sales.collected, 150);
  assert.equal(result.sections.sales.outstanding, 200);
  assert.equal(result.sections.sales.products[0].name, "Flour");
  assert.equal(result.sections.orders.open, 3);
  assert.equal(result.sections.production.produced, 20);
  assert.equal(result.sections.inventory.activeLowStock, 4);
  assert.equal(result.sections.expenses.pendingApproval, 2);
  assert.equal(result.sections.assets.dueMaintenance, 3);
  assert.equal("customer" in result.sections.sales, false);

  const hrSummary = await getSummary({
    roles: ["Human Resource"],
    from: "2025-01-01",
    to: "2025-01-07",
  });
  assert.equal(hrSummary.sections.people.pendingLeave, 1);
  assert.equal(hrSummary.sections.people.recordedAttendance, 8);

  const salesOnly = await getSummary({
    roles: ["Sales Manager"],
    from: "2025-01-01",
    to: "2025-01-07",
  });
  assert.deepEqual(Object.keys(salesOnly.sections).sort(), ["orders", "sales"]);
});

test("reports unavailable sections without converting failures into zero values", async () => {
  const errors = [];
  const getSummary = createDashboardSummary({
    Sale: { aggregate: async () => [], countDocuments: async () => 0 },
    SalePayment: { aggregate: async () => { throw new Error("database unavailable"); } },
    Order: { aggregate: async () => [], countDocuments: async () => 0 },
  }, { error: (...args) => errors.push(args) });
  const result = await getSummary({ roles: ["Sales Manager"], from: "2025-01-01", to: "2025-01-01" });
  assert.equal(result.sections.sales.status, "unavailable");
  assert.equal("revenue" in result.sections.sales, false);
  assert.equal(errors.length, 1);
});
