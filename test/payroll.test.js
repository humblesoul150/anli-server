const assert = require("node:assert/strict");
const { test } = require("node:test");
const PayrollPolicy = require("../models/payrollPolicy");
const PayrollRun = require("../models/payrollRun");
const AttendancePeriod = require("../models/attendancePeriod");
const Employee = require("../models/employee");
const controller = require("../controllers/payrollController");
const payrollRouter = require("../routes/payroll");
const { AUDIT_EVENT_TYPES } = require("../models/auditEvent");

const employeeId = "507f1f77bcf86cd799439011";

function validPolicy(overrides = {}) {
  return {
    weekStartDay: 1,
    attendanceCutoffDelayDays: 1,
    feedingAllowance: {
      defaultDailyRate: 5000,
      eligibleEmployeeIds: [employeeId],
      employeeOverrides: [{
        employeeId,
        dailyRate: 6000,
        effectiveFrom: "2026-01-01",
        effectiveTo: "",
      }],
    },
    statutoryRules: [{
      code: "EMP-TAX",
      name: "Employee tax",
      appliesTo: "Employee deduction",
      runTypes: ["Monthly", "Weekly wages"],
      employeeFlag: "taxApplies",
      method: "Progressive",
      ratePercent: 0,
      bands: [{ upTo: 100000, ratePercent: 0 }, { upTo: null, ratePercent: 10 }],
      ceiling: null,
      effectiveFrom: "2026-01-01",
      effectiveTo: "",
    }],
    ...overrides,
  };
}

test("payroll policy validates configurable week, feeding rates and effective-dated rules", () => {
  const result = controller.validatePolicy(validPolicy());
  assert.equal(result.error, undefined);
  assert.equal(result.value.feedingAllowance.defaultDailyRate, 5000);
  assert.equal(result.value.statutoryRules[0].method, "Progressive");
  assert.match(controller.validatePolicy(validPolicy({ weekStartDay: 7 })).error, /weekStartDay/);
  assert.match(controller.validatePolicy(validPolicy({
    feedingAllowance: { defaultDailyRate: -1, eligibleEmployeeIds: [], employeeOverrides: [] },
  })).error, /daily rate/);
  assert.match(controller.validatePolicy(validPolicy({
    unexpected: true,
  })).error, /unsupported fields/i);
});

test("progressive statutory calculation applies each band and ceilings", () => {
  const rule = {
    method: "Progressive",
    bands: [{ upTo: 100000, ratePercent: 0 }, { upTo: null, ratePercent: 10 }],
    ceiling: null,
  };
  assert.equal(controller.calculateRule(rule, 150000), 5000);
  assert.equal(controller.calculateRule({ ...rule, ceiling: 3000 }, 150000), 3000);
  assert.equal(controller.calculateRule({ method: "Percentage", ratePercent: 5 }, 100000), 5000);
});

test("payroll periods validate whole months and configured weekly-length boundaries", () => {
  assert.equal(controller.validateRunRequest({
    runType: "Monthly",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
  }).error, undefined);
  assert.match(controller.validateRunRequest({
    runType: "Monthly",
    periodStart: "2026-10-02",
    periodEnd: "2026-10-31",
  }).error, /full calendar month/);
  assert.match(controller.validateRunRequest({
    runType: "Payroll",
    periodStart: "2026-10-05",
    periodEnd: "2026-10-11",
  }).error, /runType/);
});

test("cash payout request requires date and rejects client-supplied payout amounts", () => {
  assert.deepEqual(controller.parsePayment({
    date: "2026-10-22",
    reference: "CASH-100",
    note: "Paid in cash",
  }).value, {
    date: "2026-10-22",
    reference: "CASH-100",
    note: "Paid in cash",
  });
  assert.match(controller.parsePayment({ date: "2026-02-30" }).error, /valid YYYY-MM-DD/);
  assert.match(controller.parsePayment({ date: "2026-10-22", amount: 1 }).error, /unsupported fields/i);
});

test("payroll schemas enforce unique run periods and valid statuses", () => {
  const indexes = PayrollRun.schema.indexes();
  assert.ok(indexes.some(([keys, options]) =>
    keys.runType === 1 && keys.periodStart === 1 && keys.periodEnd === 1 && options.unique,
  ));
  assert.ok(PayrollRun.schema.path("status").enumValues.includes("Manager approved"));
  assert.ok(AttendancePeriod.schema.path("status").enumValues.includes("Closed"));
  assert.ok(PayrollPolicy.schema.path("weekStartDay"));
  assert.ok(AUDIT_EVENT_TYPES.includes("payroll.payment_recorded"));
});

test("payroll router exposes protected run, policy, attendance-period and payslip APIs", () => {
  const paths = payrollRouter.stack.map((layer) => `${layer.route?.path}:${Object.keys(layer.route?.methods || {})[0]}`);
  for (const expected of [
    "/policy:get",
    "/policy:put",
    "/runs:post",
    "/runs:get",
    "/runs/:id/submit:post",
    "/runs/:id/decision:post",
    "/runs/:id/payment:post",
    "/attendance-periods:post",
    "/employees/:employeeId/payslips:get",
  ]) assert.ok(paths.includes(expected), expected);
});

test("payroll preparation permission is limited to Human Resource", async () => {
  let nextCalled = false;
  await payrollRouter.requirePayrollPreparer({
    authUser: { roles: ["Human Resource"] },
  }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("recalculation eligibility includes all currently eligible active employees", () => {
  assert.deepEqual(controller.eligibleEmployeeFilter("Monthly", validPolicy()), {
    status: "Active",
    compensationType: "Salary earner",
    paymentFrequency: "Monthly",
  });
  assert.deepEqual(controller.eligibleEmployeeFilter("Weekly wages", validPolicy()), {
    status: "Active",
    compensationType: "Wage earner",
    paymentFrequency: "Weekly",
  });
  assert.deepEqual(controller.eligibleEmployeeFilter("Weekly feeding", validPolicy()), {
    status: "Active",
    _id: { $in: [employeeId] },
  });
});

test("Super Admin can approve the manager stage but distinct users are required for final approval", () => {
  const awaitingManager = { status: "In review", approvals: [] };
  assert.equal(controller.approvalRole(awaitingManager, ["Super Admin"], employeeId), "General Manager");
  const run = {
    status: "Manager approved",
    approvals: [{ stage: "General Manager", decision: "Approved", actorId: employeeId }],
  };
  assert.equal(controller.approvalRole(run, ["Super Admin"], employeeId), "");
  assert.equal(controller.approvalRole(run, ["Super Admin"], "507f1f77bcf86cd799439012"), "Super Admin");
});

test("employee payslip reads expose only their approved slip and run summary", async () => {
  const originalEmployeeFindById = Employee.findById;
  const originalPayrollFind = PayrollRun.find;
  const actorId = "507f1f77bcf86cd799439012";
  const ownSlip = {
    slipId: "own-slip",
    employeeId,
    employeeNumber: "EMP-1",
    employeeName: "Employee One",
    category: "Staff employee",
    department: "Operations",
    role: "Operator",
    compensationType: "Salary earner",
    configuredRate: 100000,
    attendanceUnits: 0,
    attendance: [],
    earnings: [],
    deductions: [],
    employerContributions: [],
    grossPay: 100000,
    deductionTotal: 0,
    netPay: 100000,
    employerContributionTotal: 0,
    reviewStatus: "Ready",
    paymentStatus: "Unpaid",
  };
  let query;
  Employee.findById = () => ({
    select() { return this; },
    lean: async () => ({ _id: employeeId, userId: actorId }),
  });
  PayrollRun.find = (filter) => {
    query = filter;
    return {
      sort() { return this; },
      limit() { return this; },
      lean: async () => [{
        _id: "507f1f77bcf86cd799439013",
        reference: "PAY-M-20261031-ABC123",
        runType: "Monthly",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        status: "Paid",
        payslips: [ownSlip, { ...ownSlip, slipId: "other-slip", employeeId: "507f1f77bcf86cd799439014", employeeName: "Other Employee" }],
      }],
    };
  };
  try {
    const response = { json(body) { this.body = body; return this; } };
    await controller.listPayslips({
      params: { employeeId },
      authUser: { _id: actorId, roles: [] },
    }, response);
    assert.deepEqual(query.status, { $in: ["Approved", "Paid"] });
    assert.equal(response.body.payslips.length, 1);
    assert.equal(response.body.payslips[0].payslip.employeeName, "Employee One");
    assert.equal(response.body.payslips[0].run.reference, "PAY-M-20261031-ABC123");
    assert.equal("payslips" in response.body.payslips[0].run, false);
  } finally {
    Employee.findById = originalEmployeeFindById;
    PayrollRun.find = originalPayrollFind;
  }
});
