const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const Expense = require("../models/expense");
const ExpenseEvent = require("../models/expenseEvent");
const controller = require("../controllers/expenseController");
const expenseRouter = require("../routes/expenses");
const audit = require("../lib/audit");

const userId = "507f1f77bcf86cd799439011";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function validExpense(overrides = {}) {
  return {
    category: "Utilities",
    date: "2026-10-20",
    payee: "Power supplier",
    description: "Factory electricity",
    department: "Production",
    amount: 750000,
    ...overrides,
  };
}

test("expense model validates status, payment method, tax subtype, and idempotent import key", () => {
  const expense = new Expense({
    ...validExpense({ category: "Tax", taxType: "Corporation tax" }),
    reference: "EXP-001",
    createdBy: userId,
    createdByName: "Accountant",
  });
  assert.equal(expense.validateSync(), undefined);
  assert.ok(Expense.schema.indexes().some(([keys, options]) => keys.importKey === 1 && options.unique));
  assert.equal(Expense.schema.path("status").enumValues.includes("Legacy unverified"), true);
  assert.equal(ExpenseEvent.schema.path("eventType").enumValues.includes("Payment recorded"), true);
  assert.equal(Expense.schema.path("payments").schema.path("method").enumValues.includes("Mobile Money"), true);
});

test("expense validation requires tax type only for tax category and rejects malformed values", () => {
  assert.equal(controller.validateExpense(validExpense()).error, undefined);
  assert.equal(controller.validateExpense(validExpense({
    category: "Tax",
    taxType: "Corporation tax",
  })).error, undefined);
  assert.match(controller.validateExpense(validExpense({ category: "Tax" })).error, /taxType is required/);
  assert.match(controller.validateExpense(validExpense({ taxType: "Corporation tax" })).error, /only allowed/);
  assert.match(controller.validateExpense(validExpense({ amount: 1.5 })).error, /whole number/);
  assert.match(controller.validateExpense(validExpense({ isAdmin: true })).error, /Unsupported/);
});

test("payment validation rejects invalid method, amount and date", () => {
  assert.equal(controller.validatePayment({
    amount: 500, date: "2026-10-23", method: "Mobile Money",
  }).error, undefined);
  assert.match(controller.validatePayment({
    amount: -1, date: "2026-10-23", method: "Cash",
  }).error, /positive/);
  assert.match(controller.validatePayment({
    amount: 500, date: "not-a-date", method: "Cash",
  }).error, /valid YYYY-MM-DD/);
  assert.match(controller.validatePayment({
    amount: 500, date: "2026-10-23", method: "Crypto",
  }).error, /method is invalid/);
});

test("expense serializers omit cloudinary identifiers and calculate remaining balance", () => {
  const serialized = controller.serializeExpense({
    _id: new mongoose.Types.ObjectId(),
    reference: "EXP-001",
    category: "Tax",
    taxType: "Corporation tax",
    date: "2026-10-23",
    payee: "URA",
    description: "Tax due",
    department: "Finance",
    amount: 1000,
    status: "Partially paid",
    createdByName: "Accountant",
    createdAt: new Date("2026-10-23T10:00:00.000Z"),
    payments: [{ paymentId: "PAY-1", amount: 400, date: "2026-10-23", method: "Cash", recordedByName: "Accountant", recordedAt: new Date() }],
    attachments: [{ id: "receipt-1", name: "tax.jpg", url: "https://example.test/receipt", publicId: "private-id", mediaType: "image/jpeg", sizeBytes: 20 }],
  });
  assert.equal(serialized.source, "Manual");
  assert.equal(serialized.paidAmount, 400);
  assert.equal(serialized.remainingAmount, 600);
  assert.equal(serialized.taxType, "Corporation tax");
  assert.equal("publicId" in serialized.attachments[0], false);
});

test("payroll expense projection maps run type and is explicitly read-only", () => {
  const projected = controller.payrollExpense({
    _id: new mongoose.Types.ObjectId(),
    reference: "PAY-2026-10",
    runType: "Weekly feeding",
    periodStart: "2026-10-12",
    periodEnd: "2026-10-18",
    status: "Approved",
    payment: { amount: 40000, method: "Cash", date: "2026-10-19" },
    payslips: [
      { grossPay: 30000, employerContributionTotal: 0 },
      { grossPay: 20000, employerContributionTotal: 5000 },
    ],
  });
  assert.equal(projected.category, "Payroll");
  assert.equal(projected.payrollSubtype, "Feeding allowance");
  assert.equal(projected.amount, 55000);
  assert.equal(projected.status, "Approved");
  assert.equal(projected.paidAmount, 40000);
  assert.equal(projected.remainingAmount, 15000);
  assert.equal(projected.readOnly, true);
})

test("Super Admin can perform department actions while other expense roles stay scoped", async () => {
  const originalAudit = audit.recordAudit;
  const denied = [];
  audit.recordAudit = async (entry) => denied.push(entry);
  const request = (role) => ({ authUser: { _id: userId, name: role, roles: [role] }, baseUrl: "/api/expenses" });
  try {
    for (const [role, expected] of [
      ["Accountant", "accountant"],
      ["General Manager", "manager"],
      ["Super Admin", "Super Admin"],
      ["Admin", null],
    ]) {
      for (const [kind, middleware] of [
        ["reader", expenseRouter.requireExpenseReader],
        ["accountant", expenseRouter.requireExpenseAccountant],
        ["manager", expenseRouter.requireExpenseManager],
      ]) {
        let reached = false;
        const res = response();
        await middleware(request(role), res, () => { reached = true; });
        assert.equal(
          reached,
          role === "Super Admin" ? true : kind === "reader" ? Boolean(expected) : expected === kind,
          `${role} ${kind}`,
        );
        if (!reached) assert.equal(res.statusCode, 403);
      }
    }
    assert.ok(denied.every((entry) => entry.eventType === "security.authorization_denied"));
  } finally {
    audit.recordAudit = originalAudit;
  }
});

test("General Manager decisions update expense status and append event/audit records", async () => {
  const originalStartSession = mongoose.startSession;
  const originalFindById = Expense.findById;
  const originalCreate = ExpenseEvent.create;
  const originalAudit = audit.recordAudit;
  const calls = { events: [], audits: [] };
  const expense = {
    _id: new mongoose.Types.ObjectId(),
    reference: "EXP-001",
    category: "Utilities",
    date: "2026-10-20",
    payee: "Power supplier",
    description: "Factory electricity",
    department: "Production",
    amount: 750000,
    status: "Pending approval",
    createdByName: "Accountant",
    createdAt: new Date("2026-10-20T10:00:00Z"),
    decisions: [],
    payments: [],
    attachments: [],
    async save() {},
    toObject() { return this; },
  };
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  Expense.findById = () => ({ session: async () => expense });
  ExpenseEvent.create = async (events) => calls.events.push(...events);
  audit.recordAudit = async (entry) => calls.audits.push(entry);
  try {
    const res = response();
    await controller.decideExpense({
      params: { id: String(expense._id) },
      body: { decision: "Approved", note: "Receipt and amount verified." },
      authUser: { _id: userId, name: "General Manager" },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.expense.status, "Approved");
    assert.equal(res.body.expense.decisions[0].actor, "General Manager");
    assert.equal(calls.events[0].eventType, "Approved");
    assert.equal(calls.audits[0].eventType, "expense.approved");
  } finally {
    mongoose.startSession = originalStartSession;
    Expense.findById = originalFindById;
    ExpenseEvent.create = originalCreate;
    audit.recordAudit = originalAudit;
  }
});

test("Accountant payments support partial payment and reject overpayment", async () => {
  const originalStartSession = mongoose.startSession;
  const originalFindById = Expense.findById;
  const originalCreate = ExpenseEvent.create;
  const originalAudit = audit.recordAudit;
  const expense = {
    _id: new mongoose.Types.ObjectId(),
    reference: "EXP-002",
    category: "Utilities",
    date: "2026-10-20",
    payee: "Power supplier",
    description: "Factory electricity",
    department: "Production",
    amount: 750000,
    status: "Approved",
    createdByName: "Accountant",
    createdAt: new Date("2026-10-20T10:00:00Z"),
    decisions: [],
    payments: [],
    attachments: [],
    async save() {},
    toObject() { return this; },
  };
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  Expense.findById = () => ({ session: async () => expense });
  ExpenseEvent.create = async () => {};
  audit.recordAudit = async () => {};
  try {
    const authUser = { _id: userId, name: "Accountant" };
    const payment = { amount: 250000, date: "2026-10-22", method: "Bank transfer", reference: "TX-01" };
    const partial = response();
    await controller.recordPayment({ params: { id: String(expense._id) }, body: payment, authUser }, partial);
    assert.equal(partial.statusCode, 201);
    assert.equal(partial.body.expense.status, "Partially paid");
    assert.equal(partial.body.expense.paidAmount, 250000);
    assert.equal(partial.body.expense.remainingAmount, 500000);

    const overpayment = response();
    await controller.recordPayment({
      params: { id: String(expense._id) },
      body: { ...payment, amount: 500001 },
      authUser,
    }, overpayment);
    assert.equal(overpayment.statusCode, 409);
    assert.equal(expense.payments.length, 1);
  } finally {
    mongoose.startSession = originalStartSession;
    Expense.findById = originalFindById;
    ExpenseEvent.create = originalCreate;
    audit.recordAudit = originalAudit;
  }
});
