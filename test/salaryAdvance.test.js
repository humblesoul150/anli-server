const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const SalaryAdvance = require("../models/salaryAdvance");
const auditModel = require("../models/auditEvent");
const audit = require("../lib/audit");
const { supportedFile } = require("../controllers/salaryAdvanceAttachmentController");
const {
  companyDate,
  hasReviewerConflict,
  isDate,
  makeSchedule,
  validateCreate,
  validateDecision,
  validateLegacyAdvance,
} = require("../controllers/salaryAdvanceController");
const salaryAdvanceRouter = require("../routes/salaryAdvances");

const employeeId = "507f1f77bcf86cd799439011";
const userId = "507f1f77bcf86cd799439012";

test("salary advance schema captures sequential approvals, financial history, and unique references", () => {
  const advance = new SalaryAdvance({
    reference: "ADV-TEST001",
    employeeId,
    employeeNumber: "EMP-001",
    employeeName: "Test Employee",
    department: "Finance",
    role: "Analyst",
    category: "Staff",
    requestedAmount: 100000,
    reason: "Emergency",
    dateTaken: companyDate(),
    proposedFrequency: "Monthly",
    proposedInstallmentAmount: 25000,
    createdBy: userId,
    updatedBy: userId,
  });
  assert.equal(advance.status, "Pending HR review");
  assert.deepEqual(advance.schedule, []);
  assert.deepEqual(advance.repayments, []);
  assert.equal(advance.validateSync(), undefined);
  assert.equal(SalaryAdvance.schema.path("employeeId").options.ref, "Employee");
  assert.ok(SalaryAdvance.schema.indexes().some(([keys, options]) => keys.reference === 1 && options.unique));
  assert.ok(SalaryAdvance.schema.indexes().some(([keys, options]) => keys["repayments.idempotencyKey"] === 1 && options.unique));
  assert.ok(auditModel.AUDIT_EVENT_TYPES.includes("salary_advance.gm_approved"));
  assert.ok(auditModel.AUDIT_EVENT_TYPES.includes("salary_advance.repaid"));

  const legacy = new SalaryAdvance({
    reference: "ADV-L-12345678",
    employeeNumber: "EMP-OLD",
    employeeName: "Legacy Employee",
    department: "Unknown",
    role: "Unknown",
    category: "Other",
    requestedAmount: 1000,
    reason: "Legacy import",
    dateTaken: companyDate(),
    proposedFrequency: "Monthly",
    proposedInstallmentAmount: 1000,
    status: "Legacy archive",
    legacyUnverified: true,
    legacyStatus: "Approved",
    legacyImportKey: "legacy-test-key",
    createdBy: userId,
    updatedBy: userId,
  });
  assert.equal(legacy.validateSync(), undefined);
});

test("salary advance request and decision validators enforce supported fields and financial bounds", () => {
  const valid = {
    employeeId,
    requestedAmount: 100000,
    reason: "Urgent household expense",
    dateTaken: companyDate(),
    proposedFrequency: "Monthly",
    proposedInstallmentAmount: 25000,
  };
  assert.equal(validateCreate(valid).error, undefined);
  assert.match(validateCreate({ ...valid, dateTaken: "2026-02-30" }).error, /valid date/);
  assert.match(validateCreate({ ...valid, requestedAmount: 0 }).error, /positive whole amount/);
  assert.match(validateCreate({ ...valid, unsupported: true }).error, /supported shape/);

  assert.equal(validateDecision({ decision: "Rejected", note: "Insufficient details" }, "Human Resource").error, undefined);
  assert.match(validateDecision({ decision: "Rejected" }, "General Manager").error, /rejection reason/);
  assert.equal(validateDecision({ decision: "Approved", amount: 100000, frequency: "Monthly", installmentAmount: 25000 }, "General Manager").error, undefined);
  assert.match(validateDecision({ decision: "Approved", amount: 1000, frequency: "Yearly", installmentAmount: 2000 }, "Human Resource").error, /Approval requires/);
});

test("HR and General Manager cannot self-approve or reuse the previous-stage reviewer", () => {
  const advance = {
    createdBy: userId,
    hrDecision: { actorId: "507f1f77bcf86cd799439013" },
  };
  assert.equal(hasReviewerConflict(advance, userId, "Human Resource"), true);
  assert.equal(hasReviewerConflict(advance, "507f1f77bcf86cd799439013", "General Manager"), true);
  assert.equal(hasReviewerConflict(advance, "507f1f77bcf86cd799439014", "General Manager"), false);
});

test("legacy archive validation accepts bounded request snapshots and rejects invalid records", () => {
  const valid = validateLegacyAdvance({
    id: "local-advance-1",
    reference: "ADV-LOCAL-1",
    employeeNumber: "EMP-001",
    employeeName: "Test Employee",
    requestedAmount: 100000,
    reason: "Imported request",
    dateTaken: companyDate(),
    proposedFrequency: "Monthly",
    proposedInstallmentAmount: 25000,
    status: "Approved",
    attachments: [{ dataUrl: "data:image/jpeg;base64,large-local-file" }],
  });
  assert.equal(valid.error, undefined);
  assert.equal(valid.value.legacyStatus, "Approved");
  assert.equal("attachments" in valid.value, false);
  assert.match(validateLegacyAdvance({ employeeName: "Test", requestedAmount: 0 }).error, /must be valid/);
});

test("repayment schedule is date-only, clamps monthly dates, and caps entries", () => {
  assert.equal(isDate("2026-10-20"), true);
  assert.equal(isDate("2026-02-30"), false);
  const schedule = makeSchedule("2026-01-31", "Monthly", 300, 700);
  assert.deepEqual(schedule.map((entry) => entry.dueDate), ["2026-01-31", "2026-02-28", "2026-03-28"]);
  assert.deepEqual(schedule.map((entry) => entry.plannedAmount), [300, 300, 100]);
  assert.equal(makeSchedule(companyDate(), "Monthly", 1, 1000).length, 120);
});

test("advance attachments require matching image or PDF signatures", () => {
  assert.equal(supportedFile({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }).mediaType, "image/jpeg");
  assert.equal(supportedFile({ buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }).mediaType, "image/png");
  assert.equal(supportedFile({ buffer: Buffer.from("%PDF-1.7") }).resourceType, "raw");
  assert.equal(supportedFile({ buffer: Buffer.from("not a file") }), null);
});

test("salary advance role guards allow only HR for HR decisions and GM for final approval", async () => {
  const originalAudit = audit.recordAudit;
  audit.recordAudit = async () => {};
  async function check(middleware, roles) {
    let nextCalled = false;
    let statusCode;
    const response = { status(value) { statusCode = value; return this; }, json() { return this; } };
    const request = {
      authUser: { _id: new mongoose.Types.ObjectId(userId), name: "Reviewer", roles },
      baseUrl: "/api/salary-advances",
    };
    await middleware(request, response, () => { nextCalled = true; });
    return { nextCalled, statusCode };
  }
  try {
    assert.deepEqual(await check(salaryAdvanceRouter.requireHrManager, ["Human Resource"]), { nextCalled: true, statusCode: undefined });
    assert.deepEqual(await check(salaryAdvanceRouter.requireHrManager, ["General Manager"]), { nextCalled: false, statusCode: 403 });
    assert.deepEqual(await check(salaryAdvanceRouter.requireGeneralManager, ["General Manager"]), { nextCalled: true, statusCode: undefined });
    assert.deepEqual(await check(salaryAdvanceRouter.requireGeneralManager, ["Super Admin", "Admin"]), { nextCalled: false, statusCode: 403 });
  } finally {
    audit.recordAudit = originalAudit;
  }
});
