const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const Customer = require("../models/customer");
const controller = require("../controllers/customerController");
const customerRouter = require("../routes/customers");
const audit = require("../lib/audit");

const userId = "507f1f77bcf86cd799439011";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function validCustomer(overrides = {}) {
  return {
    name: "  Nile Foods Ltd  ",
    type: "Wholesale",
    phone: "+256 772 555 019",
    email: "orders@nilefoods.ug",
    ...overrides,
  };
}

test("customer schema enforces unique stable IDs and normalized names", () => {
  const customer = new Customer({
    id: "C-001",
    ...validCustomer(),
    nameKey: controller.customerNameKey("Nile Foods Ltd"),
    createdBy: userId,
    updatedBy: userId,
  });
  assert.equal(customer.validateSync(), undefined);
  const uniqueIndexes = Customer.schema.indexes().filter(([, options]) => options.unique);
  assert.ok(uniqueIndexes.some(([keys]) => keys.id === 1));
  assert.ok(uniqueIndexes.some(([keys]) => keys.nameKey === 1));
});

test("customer validation trims and normalizes values and rejects unsupported or malformed fields", () => {
  const valid = controller.validateCustomer(validCustomer());
  assert.equal(valid.error, undefined);
  assert.equal(valid.value.name, "Nile Foods Ltd");
  assert.equal(valid.value.email, "orders@nilefoods.ug");
  assert.equal(controller.customerNameKey(valid.value.name), "nile foods ltd");

  assert.match(controller.validateCustomer(validCustomer({ name: " " })).error, /name is required/);
  assert.match(controller.validateCustomer(validCustomer({ email: "not-an-email" })).error, /valid email/);
  assert.match(controller.validateCustomer(validCustomer({ unexpected: true })).error, /Unsupported/);
  assert.match(controller.validateCustomer(validCustomer({ status: "Deleted" })).error, /status is invalid/);
  assert.match(controller.validateCustomer(validCustomer({ notes: "x".repeat(2001) })).error, /at most 2000/);
  assert.match(controller.validateCustomer({ id: "bad/id", ...validCustomer() }, { importing: true }).error, /identifier/);
  assert.equal(controller.validateCustomer({ status: "Inactive" }, { partial: true }).error, undefined);
  assert.match(controller.validateCustomer({}, { partial: true }).error, /At least one/);
});

test("customer serializer returns only the public profile shape", () => {
  const serialized = controller.serializeCustomer({
    _id: new mongoose.Types.ObjectId(),
    id: "C-001",
    name: "Nile Foods Ltd",
    nameKey: "nile foods ltd",
    type: "Wholesale",
    phone: "+256 772 555 019",
    email: "",
    status: "Active",
    archivedAt: null,
    createdBy: userId,
    updatedBy: userId,
    createdAt: new Date("2026-10-23T10:00:00.000Z"),
  });
  assert.equal(serialized.id, "C-001");
  assert.equal(serialized.email, "");
  assert.equal("nameKey" in serialized, false);
  assert.equal("createdBy" in serialized, false);
});

test("customer import skips already imported IDs and reports name collisions", async () => {
  const originalExists = Customer.exists;
  const originalCreate = Customer.create;
  const originalAudit = audit.recordAudit;
  const auditEvents = [];
  Customer.exists = async ({ id }) => id === "C-EXISTING";
  Customer.create = async (input) => {
    if (input.nameKey === "duplicate") {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    return { ...input, createdAt: new Date(), archivedAt: null };
  };
  audit.recordAudit = async (entry) => auditEvents.push(entry);
  const req = {
    body: {
      customers: [
        { id: "C-EXISTING", ...validCustomer({ name: "Already imported" }) },
        { id: "C-002", ...validCustomer({ name: "New customer" }) },
        { id: "C-003", ...validCustomer({ name: "Duplicate" }) },
      ],
    },
    authUser: { _id: userId, name: "Sales Manager" },
  };
  try {
    const res = response();
    await controller.importLegacyCustomers(req, res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body.existing, ["C-EXISTING"]);
    assert.deepEqual(res.body.imported.map((item) => item.id), ["C-002"]);
    assert.equal(res.body.rejected[0].id, "C-003");
    assert.equal(auditEvents[0].eventType, "customer.legacy_imported");
  } finally {
    Customer.exists = originalExists;
    Customer.create = originalCreate;
    audit.recordAudit = originalAudit;
  }
});

test("customer role middleware allows the selected roles and audits denied access", async () => {
  const originalAudit = audit.recordAudit;
  const denied = [];
  audit.recordAudit = async (entry) => denied.push(entry);
  const request = (role) => ({
    authUser: { _id: userId, name: role, roles: [role] },
    baseUrl: "/api/customers",
  });
  try {
    for (const [role, canRead, canWrite] of [
      ["Sales Manager", true, true],
      ["Marketing Manager", true, false],
      ["General Manager", true, true],
      ["Admin", true, true],
      ["Super Admin", true, true],
      ["Accountant", false, false],
    ]) {
      let readReached = false;
      let writeReached = false;
      const readRes = response();
      const writeRes = response();
      await customerRouter.requireCustomerReader(request(role), readRes, () => { readReached = true; });
      await customerRouter.requireCustomerManager(request(role), writeRes, () => { writeReached = true; });
      assert.equal(readReached, canRead, `${role} read`);
      assert.equal(writeReached, canWrite, `${role} write`);
      if (!canRead) assert.equal(readRes.statusCode, 403);
      if (!canWrite) assert.equal(writeRes.statusCode, 403);
    }
    assert.ok(denied.every((entry) => entry.eventType === "security.authorization_denied"));
  } finally {
    audit.recordAudit = originalAudit;
  }
});
