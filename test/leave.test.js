const assert = require("node:assert/strict");
const { test } = require("node:test");
const LegacyLeaveArchive = require("../models/legacyLeaveArchive");
const LeavePolicy = require("../models/leavePolicy");
const LeaveRequest = require("../models/leaveRequest");
const {
  addBusinessDays,
  calculateWorkingDays,
  expectedReturnDate,
  getReminderCandidates,
  isValidDate,
  leaveYearBounds,
} = require("../lib/leavePolicy");
const {
  legacyLeaveImportKey,
  employeeBalance,
  validateLegacyLeave,
  validatePolicy,
  validateRequestInput,
} = require("../controllers/leaveController");

test("leave models enforce references, statuses, policy defaults, and unique linked employee accounts", () => {
  const userId = "507f1f77bcf86cd799439011";
  const employeeId = "507f1f77bcf86cd799439012";
  const request = new LeaveRequest({
    reference: "LV-2026-TEST0001",
    employeeId,
    employeeUserId: userId,
    requesterUserId: userId,
    approverUserId: "507f1f77bcf86cd799439013",
    leaveType: "Annual",
    reason: "Family plans",
    startDate: "2026-10-22",
    endDate: "2026-10-23",
    requestedDays: 2,
    handoverEmployeeId: "507f1f77bcf86cd799439014",
    handoverName: "Handover employee",
    createdBy: userId,
    updatedBy: userId,
  });

  assert.equal(request.validateSync(), undefined);
  assert.equal(LeaveRequest.schema.options.optimisticConcurrency, true);
  assert.equal(LeaveRequest.schema.path("employeeUserId").options.ref, "User");

  const policy = new LeavePolicy();
  assert.deepEqual(policy.workingDays, [1, 2, 3, 4, 5, 6]);
  assert.equal(policy.carryoverEnabled, false);
  assert.equal(LeavePolicy.schema.path("workingDays").options.default.length, 6);

});

test("legacy leave records are validated and archived without granting approved status", () => {
  const legacy = {
    id: "browser-leave-1",
    reference: "LV-OLD-001",
    employeeNumber: "EMP-001",
    employeeName: "Legacy Employee",
    leaveType: "Annual",
    reason: "Personal leave",
    startDate: "2024-03-04",
    endDate: "2024-03-06",
    status: "Approved",
  };
  const validated = validateLegacyLeave(legacy);
  assert.equal(validated.error, undefined);
  assert.equal(validated.value.originalStatus, "Approved");
  assert.equal(legacyLeaveImportKey(validated.value), legacyLeaveImportKey(validated.value));
  assert.match(validateLegacyLeave({ ...legacy, startDate: "2024-02-30" }).error, /valid leave dates/);

  const archive = new LegacyLeaveArchive({
    ...validated.value,
    legacyImportKey: legacyLeaveImportKey(validated.value),
    requestedDays: 3,
    importedBy: "507f1f77bcf86cd799439011",
  });
  assert.equal(archive.validateSync(), undefined);
  assert.equal(archive.status, undefined);
  assert.equal(LegacyLeaveArchive.schema.path("originalStatus").enumValues.includes("Approved"), true);
});

test("workday calculation uses configurable Mon-Sat schedule and holidays", () => {
  const policy = {
    workingDays: [1, 2, 3, 4, 5, 6],
    holidays: ["2026-10-24"],
  };
  assert.equal(calculateWorkingDays("2026-10-23", "2026-10-26", policy), 2);
  assert.equal(calculateWorkingDays("2026-10-25", "2026-10-25", policy), 0);
  assert.equal(calculateWorkingDays("2026-10-26", "2026-10-23", policy), 0);
  assert.equal(isValidDate("2026-02-30"), false);
  assert.equal(isValidDate("2026-02-28"), true);
});

test("business-day thresholds, expected return dates, and leap-day leave years are safe", () => {
  const policy = { workingDays: [1, 2, 3, 4, 5, 6], holidays: ["2026-10-26"] };
  assert.equal(addBusinessDays("2026-10-24", 2, policy), "2026-10-28");
  assert.equal(expectedReturnDate("2026-10-24", policy), "2026-10-27");
  assert.deepEqual(leaveYearBounds("2025-03-01", "02-29"), {
    start: "2025-02-28",
    end: "2026-02-27",
  });
});

test("annual leave balances apply capped carryover from the preceding leave year", async () => {
  const policy = {
    workingDays: [1, 2, 3, 4, 5, 6],
    holidays: [],
    leaveYearStart: "01-01",
    entitlements: { Annual: 20 },
    carryoverEnabled: true,
    carryoverLimit: 5,
  };
  const requests = [
    { leaveType: "Annual", status: "Approved", startDate: "2025-06-02", endDate: "2025-06-06" },
    { leaveType: "Annual", status: "Approved", startDate: "2026-06-01", endDate: "2026-06-04" },
    { leaveType: "Annual", status: "Pending", startDate: "2026-06-05", endDate: "2026-06-05" },
  ];
  const balance = await employeeBalance("employee", "Annual", "2026-06-01", requests, policy);
  assert.deepEqual(balance, { configured: true, entitlement: 20, carryover: 5, used: 4, pending: 1, available: 20 });
});

test("reminder candidates include pending and approved thresholds but exclude completed leave", () => {
  const requests = [
    {
      _id: "pending-id",
      status: "Pending",
      createdAt: new Date("2026-10-20T08:00:00Z"),
      approverUserId: "approver",
    },
    {
      _id: "approved-id",
      status: "Approved",
      startDate: "2026-10-30",
      endDate: "2026-10-31",
      approverUserId: "approver",
    },
    {
      _id: "cancelled-id",
      status: "Cancelled",
      startDate: "2026-10-30",
      endDate: "2026-10-31",
      approverUserId: "approver",
    },
    {
      _id: "returned-id",
      status: "Approved",
      startDate: "2026-10-30",
      endDate: "2026-10-31",
      approverUserId: "approver",
      returnConfirmation: { actualDate: "2026-11-02" },
    },
  ];
  const policy = {
    workingDays: [1, 2, 3, 4, 5, 6],
    holidays: [],
    reminderThresholds: {
      pendingApprovalBusinessDays: 2,
      beforeStartDays: [7, 1],
      onStartDate: true,
      returnFollowUp: true,
    },
  };
  const candidates = getReminderCandidates(requests, policy);
  assert.deepEqual(candidates.map((candidate) => candidate.key), [
    "leave:pending-id:pending:2026-10-22",
    "leave:approved-id:start-minus-7:2026-10-30",
    "leave:approved-id:start-minus-1:2026-10-30",
    "leave:approved-id:start:2026-10-30",
    "leave:approved-id:return:2026-11-02",
  ]);
  assert.ok(candidates.every((candidate) => !candidate.key.includes("cancelled-id")));
  assert.ok(candidates.every((candidate) => !candidate.key.includes("returned-id")));
});

test("leave API validators reject unsafe policy and request shapes", () => {
  assert.equal(validatePolicy({ workingDays: [1, 2, 3, 4, 5, 6] }).error, undefined);
  assert.match(validatePolicy({ workingDays: [0, 7] }).error, /weekday numbers/);
  assert.match(validatePolicy({ leaveYearStart: "02-31" }).error, /valid MM-DD/);
  assert.match(validatePolicy({ carryoverEnabled: false, carryoverLimit: 2 }).error, /zero/);
  assert.equal(validateRequestInput({
    leaveType: "Sick",
    reason: "Medical appointment",
    startDate: "2026-10-22",
    endDate: "2026-10-23",
    handoverEmployeeId: "507f1f77bcf86cd799439012",
  }).error, undefined);
  assert.match(validateRequestInput({
    leaveType: "Other",
    otherLeaveType: "",
    reason: "Reason",
    startDate: "2026-02-30",
    endDate: "2026-10-23",
    handoverEmployeeId: "bad",
  }).error, /Specify the other leave type/);
});
