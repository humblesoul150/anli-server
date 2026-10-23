const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildApprovalItems } = require("../controllers/approvalsController");

test("approval inbox classifies actionable and completed leave requests and amendments", () => {
  const user = { _id: "reviewer", roles: ["Human Resource"] };
  const items = buildApprovalItems({
    leaves: [
      {
        _id: "leave-id",
        reference: "LV-001",
        requesterUserId: "employee",
        approverUserId: "reviewer",
        employeeId: { firstName: "Amina", secondName: "Nabirye" },
        leaveType: "Annual",
        requestedDays: 3,
        startDate: "2026-11-02",
        endDate: "2026-11-04",
        status: "Pending",
        reason: "Family event",
        createdAt: new Date("2026-10-01T09:00:00.000Z"),
        decisions: [],
        amendments: [],
      },
      {
        _id: "leave-approved-id",
        reference: "LV-002",
        requesterUserId: "employee",
        approverUserId: "reviewer",
        employeeId: { firstName: "Amina", secondName: "Nabirye" },
        leaveType: "Annual",
        requestedDays: 3,
        startDate: "2026-11-02",
        endDate: "2026-11-04",
        status: "Approved",
        reason: "Family event",
        createdAt: new Date("2026-10-01T09:00:00.000Z"),
        decisions: [],
        amendments: [{
          _id: "amendment-id",
          requestedBy: "employee",
          requestedAt: new Date("2026-10-02T09:00:00.000Z"),
          requestedDays: 2,
          startDate: "2026-11-03",
          endDate: "2026-11-04",
          reason: "Date change",
          status: "Pending",
        }],
      },
    ],
  }, user);
  const leave = items.find((item) => item.source === "Leave");
  const amendment = items.find((item) => item.source === "Leave amendment");

  assert.equal(leave.source, "Leave");
  assert.equal(leave.status, "Awaiting review");
  assert.equal(leave.canAct, true);
  assert.match(leave.requester, /Amina Nabirye/);
  assert.equal(amendment.source, "Leave amendment");
  assert.equal(amendment.recordId, "leave-approved-id");
  assert.equal(amendment.subRecordId, "amendment-id");
  assert.equal(amendment.canAct, true);
});

test("approval inbox preserves sequential payroll and salary advance reviewer constraints", () => {
  const records = {
    advances: [{
      _id: "advance-id",
      reference: "ADV-1",
      employeeName: "Employee",
      status: "Pending GM review",
      createdBy: "employee",
      requestedAmount: 1000,
      proposedFrequency: "Monthly",
      proposedInstallmentAmount: 100,
      hrDecision: { actorId: "gm", actorName: "GM", decision: "Approved", decidedAt: new Date() },
      requestedAt: new Date(),
    }],
    payrollRuns: [{
      _id: "run-id",
      reference: "PAY-1",
      runType: "Monthly",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      status: "Manager approved",
      createdByName: "HR",
      submittedAt: new Date(),
      payslips: [{ netPay: 100 }],
      approvals: [{ stage: "General Manager", decision: "Approved", actorId: "super", actorName: "Super", decidedAt: new Date() }],
    }],
  };

  const sameReviewerItems = buildApprovalItems(records, { _id: "gm", roles: ["General Manager"] });
  assert.equal(sameReviewerItems.find((item) => item.source === "Salary advance").canAct, false);
  assert.equal(sameReviewerItems.find((item) => item.source === "Payroll").canAct, false);

  const nextReviewerItems = buildApprovalItems(records, { _id: "different-super", roles: ["Super Admin"] });
  assert.equal(nextReviewerItems.find((item) => item.source === "Payroll").canAct, true);
});

test("disciplinary inbox exposes items only as actionable for the assigned current stage", () => {
  const records = {
    disciplinaryCases: [{
      _id: "case-id",
      reference: "DISC-1",
      employeeName: "Employee",
      department: "Operations",
      type: "Written warning",
      status: "Pending General Manager approval",
      incidentDate: "2026-09-01",
      allegation: "Private case detail",
      reason: "Investigation outcome",
      createdBy: "hr-user",
      createdAt: new Date(),
      approvalRound: 1,
      approvals: [{ round: 1, stage: "Human Resource", decision: "Approved", actorName: "HR", decidedAt: new Date() }],
      assignedApprovers: { generalManager: "gm-user" },
    }, {
      _id: "same-reviewer-case",
      reference: "DISC-2",
      employeeName: "Other employee",
      department: "Operations",
      type: "Written warning",
      status: "Pending General Manager approval",
      incidentDate: "2026-09-02",
      createdBy: "hr-user",
      createdAt: new Date(),
      approvalRound: 1,
      approvals: [{ round: 1, stage: "Human Resource", decision: "Approved", actorId: "multi-role-user", actorName: "HR/GM", decidedAt: new Date() }],
      assignedApprovers: { generalManager: "multi-role-user" },
    }],
  };

  const assigned = buildApprovalItems(records, { _id: "gm-user", roles: ["General Manager"] })[0];
  const unassigned = buildApprovalItems(records, { _id: "other-gm", roles: ["General Manager"] })[0];
  const creator = buildApprovalItems(records, { _id: "hr-user", roles: ["General Manager"] })[0];
  const sameReviewer = buildApprovalItems(records, { _id: "multi-role-user", roles: ["Human Resource", "General Manager"] })
    .find((item) => item.recordId === "same-reviewer-case");

  assert.equal(assigned.canAct, true);
  assert.equal(unassigned.canAct, false);
  assert.equal(creator.canAct, false);
  assert.equal(sameReviewer.canAct, false);
  assert.match(assigned.detail, /Private case detail/);
});
