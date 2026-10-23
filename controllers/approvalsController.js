const Employee = require("../models/employee");
const Expense = require("../models/expense");
const LeaveRequest = require("../models/leaveRequest");
const PayrollRun = require("../models/payrollRun");
const SalaryAdvance = require("../models/salaryAdvance");
const DisciplinaryCase = require("../models/disciplinaryCase");

const INBOX_LIMIT = 500;
const READ_ROLES = {
  salaryAdvances: ["Human Resource", "General Manager", "Admin"],
  payroll: ["Human Resource", "General Manager", "Accountant"],
  expenses: ["Accountant", "General Manager"],
};

function hasRole(user, roles) {
  return user?.roles?.some((role) => roles.includes(role)) || user?.roles?.includes("Super Admin");
}

function idOf(value) {
  return String(value?._id || value?.id || value || "");
}

function dateOf(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function statusFor(decision) {
  if (decision === "Approved") return "Approved";
  if (decision === "Rejected") return "Rejected";
  if (decision === "Returned") return "Returned";
  if (decision === "Cancelled") return "Cancelled";
  if (decision === "Rescinded") return "Cancelled";
  return "In progress";
}

function historyEntry(stage, decision, actor, at, note = "") {
  return { stage, decision, actor: actor || "Unknown reviewer", at: dateOf(at), note: note || "" };
}

function makeItem(value) {
  return {
    id: value.id,
    source: value.source,
    recordId: value.recordId,
    subRecordId: value.subRecordId || null,
    reference: value.reference,
    requester: value.requester || "Requester not recorded",
    submittedAt: dateOf(value.submittedAt),
    summary: value.summary,
    detail: value.detail || "",
    amount: value.amount,
    status: value.actionable ? "Awaiting review" : value.status,
    stage: value.stage || "",
    canAct: Boolean(value.actionable),
    history: value.history || [],
    salaryAdvance: value.salaryAdvance,
  };
}

function buildApprovalItems(records, user) {
  const actorId = idOf(user?._id || user?.id);
  const roles = user?.roles || [];
  const items = [];

  for (const leave of records.leaves || []) {
    const employeeName = leave.employeeId && typeof leave.employeeId === "object"
      ? [leave.employeeId.firstName, leave.employeeId.secondName, leave.employeeId.otherNames].filter(Boolean).join(" ") || leave.employeeId.name
      : "Employee";
    const requester = employeeName || "Employee";
    const leaveType = leave.leaveType === "Other" ? leave.otherLeaveType : leave.leaveType;
    const requestCanAct = leave.status === "Pending"
      && idOf(leave.requesterUserId) !== actorId
      && (hasRole(user, ["Human Resource", "Admin"]) || idOf(leave.approverUserId) === actorId);
    const decisionHistory = (leave.decisions || []).map((decision) => historyEntry(
      "Leave", decision.decision, decision.actorName, decision.at, decision.note,
    ));
    items.push(makeItem({
      id: `leave:${idOf(leave)}`,
      source: "Leave",
      recordId: idOf(leave),
      reference: leave.reference,
      requester,
      submittedAt: leave.createdAt || leave.requestedAt,
      summary: `${leaveType} · ${leave.requestedDays} working days · ${leave.startDate} to ${leave.endDate}`,
      detail: `${leave.reason}\nHandover: ${leave.handoverName || "Not specified"} · ${leave.department || leave.employeeId?.department || "Department not recorded"}`,
      stage: "Assigned reviewer",
      actionable: requestCanAct,
      status: statusFor(leave.status),
      history: decisionHistory,
    }));

    for (const amendment of leave.amendments || []) {
      const canAct = amendment.status === "Pending"
        && leave.status === "Approved"
        && idOf(amendment.requestedBy) !== actorId
        && idOf(leave.approverUserId) !== actorId
        && hasRole(user, ["Human Resource", "Admin"]);
      const assignedCanAct = amendment.status === "Pending"
        && leave.status === "Approved"
        && idOf(amendment.requestedBy) !== actorId
        && idOf(leave.approverUserId) === actorId;
      items.push(makeItem({
        id: `leave-amendment:${idOf(leave)}:${idOf(amendment)}`,
        source: "Leave amendment",
        recordId: idOf(leave),
        subRecordId: idOf(amendment),
        reference: leave.reference,
        requester,
        submittedAt: amendment.requestedAt,
        summary: `${leaveType} · ${amendment.requestedDays} working days · ${amendment.startDate} to ${amendment.endDate}`,
        detail: `${amendment.reason}\nCurrent leave: ${leave.startDate} to ${leave.endDate}`,
        stage: "Assigned reviewer",
        actionable: canAct || assignedCanAct,
        status: statusFor(amendment.status),
        history: amendment.status === "Pending" ? [] : [
          historyEntry("Leave amendment", amendment.status, amendment.decidedBy?.name, amendment.decidedAt, amendment.decisionNote),
        ],
      }));
    }
  }

  for (const advance of records.advances || []) {
    const stage = advance.status === "Pending HR review" ? "Human Resource"
      : advance.status === "Pending GM review" ? "General Manager" : "";
    const roleAllowed = stage && roles.includes(stage);
    const reviewerConflict = idOf(advance.createdBy) === actorId
      || stage === "General Manager" && idOf(advance.hrDecision?.actorId) === actorId;
    const history = [
      advance.hrDecision && historyEntry("Human Resource", advance.hrDecision.decision, advance.hrDecision.actorName, advance.hrDecision.decidedAt, advance.hrDecision.note),
      advance.gmDecision && historyEntry("General Manager", advance.gmDecision.decision, advance.gmDecision.actorName, advance.gmDecision.decidedAt, advance.gmDecision.note),
    ].filter(Boolean);
    items.push(makeItem({
      id: `salary-advance:${idOf(advance)}`,
      source: "Salary advance",
      recordId: idOf(advance),
      reference: advance.reference,
      requester: advance.employeeName,
      submittedAt: advance.requestedAt || advance.createdAt,
      summary: `Requested ${advance.requestedAmount} · ${advance.proposedFrequency} repayment`,
      detail: `${advance.reason}\nDate taken: ${advance.dateTaken} · Proposed installment: ${advance.hrDecision?.installmentAmount || advance.proposedInstallmentAmount}`,
      amount: advance.requestedAmount,
      stage,
      actionable: Boolean(stage && roleAllowed && !reviewerConflict),
      status: advance.status === "Rejected" ? "Rejected"
        : ["Approved", "Active", "Settled"].includes(advance.status) ? "Approved" : "In progress",
      history,
      salaryAdvance: {
        status: advance.status,
        requestedAmount: advance.requestedAmount,
        proposedFrequency: advance.proposedFrequency,
        proposedInstallmentAmount: advance.proposedInstallmentAmount,
        hrDecision: advance.hrDecision ? {
          amount: advance.hrDecision.amount,
          frequency: advance.hrDecision.frequency,
          installmentAmount: advance.hrDecision.installmentAmount,
        } : null,
      },
    }));
  }

  for (const run of records.payrollRuns || []) {
    const stage = run.status === "In review" ? "General Manager"
      : run.status === "Manager approved" ? "Super Admin" : "";
    const managerApproval = (run.approvals || []).find((approval) => approval.stage === "General Manager" && approval.decision === "Approved");
    const roleAllowed = stage === "General Manager"
      ? roles.includes("General Manager") || roles.includes("Super Admin")
      : stage === "Super Admin" && roles.includes("Super Admin")
        && idOf(managerApproval?.actorId) !== actorId;
    const history = (run.approvals || []).map((approval) => historyEntry(
      approval.stage, approval.decision, approval.actorName, approval.decidedAt, approval.note,
    ));
    const netPay = (run.payslips || []).reduce((sum, slip) => sum + (slip.netPay || 0), 0);
    items.push(makeItem({
      id: `payroll:${idOf(run)}`,
      source: "Payroll",
      recordId: idOf(run),
      reference: run.reference,
      requester: run.createdByName,
      submittedAt: run.submittedAt || run.updatedAt,
      summary: `${run.runType} · ${run.periodStart} to ${run.periodEnd} · ${(run.payslips || []).length} payslips · ${netPay} net`,
      detail: run.returnedNote || `Payroll run for ${run.periodStart} to ${run.periodEnd}.`,
      amount: netPay,
      stage,
      actionable: Boolean(stage && roleAllowed),
      status: run.status === "Returned" ? "Returned"
        : ["Approved", "Paid"].includes(run.status) ? "Approved" : "In progress",
      history,
    }));
  }

  for (const expense of records.expenses || []) {
    const actionable = expense.status === "Pending approval" && roles.includes("General Manager");
    const decisions = (expense.decisions || []).map((decision) => historyEntry(
      "General Manager", decision.decision, decision.actorName, decision.at, decision.note,
    ));
    items.push(makeItem({
      id: `expense:${idOf(expense)}`,
      source: "Expense",
      recordId: idOf(expense),
      reference: expense.reference,
      requester: expense.createdByName,
      submittedAt: expense.createdAt,
      summary: `${expense.payee} · ${expense.category} · ${expense.department}`,
      detail: `${expense.description}\nDate: ${expense.date}`,
      amount: expense.amount,
      stage: "General Manager",
      actionable,
      status: expense.status === "Rejected" ? "Rejected"
        : expense.status === "Approved" || ["Partially paid", "Paid"].includes(expense.status) ? "Approved" : "In progress",
      history: decisions,
    }));
  }

  for (const caseRecord of records.disciplinaryCases || []) {
    const stage = caseRecord.status === "Pending Human Resource approval" ? "Human Resource"
      : caseRecord.status === "Pending General Manager approval" ? "General Manager"
        : caseRecord.status === "Pending Super Admin approval" ? "Super Admin" : "";
    const assignedApprover = stage === "Human Resource" ? caseRecord.assignedApprovers?.humanResource
      : stage === "General Manager" ? caseRecord.assignedApprovers?.generalManager
        : stage === "Super Admin" ? caseRecord.assignedApprovers?.superAdmin : null;
    const stageIndex = ["Human Resource", "General Manager", "Super Admin"].indexOf(stage);
    const currentRound = (caseRecord.approvals || []).filter((approval) => approval.round === caseRecord.approvalRound);
    const hasRoleForStage = roles.includes(stage);
    const assigned = stage === "Super Admin" && roles.includes("Super Admin")
      || idOf(assignedApprover) === actorId;
    const actionable = Boolean(stage && hasRoleForStage && assigned
      && idOf(caseRecord.createdBy) !== actorId
      && !currentRound.some((approval) => idOf(approval.actorId) === actorId)
      && currentRound.length === stageIndex);
    const history = (caseRecord.approvals || []).map((approval) => historyEntry(
      `Round ${approval.round} · ${approval.stage}`, approval.decision,
      approval.actorName, approval.decidedAt, approval.note,
    ));
    items.push(makeItem({
      id: `disciplinary:${idOf(caseRecord)}`,
      source: "Disciplinary",
      recordId: idOf(caseRecord),
      reference: caseRecord.reference,
      requester: caseRecord.employeeName,
      submittedAt: caseRecord.createdAt,
      summary: `${caseRecord.type} · ${caseRecord.department} · Incident ${caseRecord.incidentDate}`,
      detail: `${caseRecord.allegation}\n${caseRecord.reason}${caseRecord.response?.text ? `\nEmployee response: ${caseRecord.response.text}` : ""}`,
      stage,
      actionable,
      status: caseRecord.status === "Changes requested" ? "Returned"
        : caseRecord.status === "Rescinded" ? "Cancelled"
        : ["Approved", "Issued", "Closed"].includes(caseRecord.status) ? "Approved" : "In progress",
      history,
    }));
  }

  return items.sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
}

async function listApprovalInbox(request, response) {
  const user = request.authUser;
  const actorId = user._id;
  const reads = [];
  const readSources = [];
  const addRead = (source, query) => {
    readSources.push(source);
    reads.push(query);
  };

  if (hasRole(user, ["Human Resource", "Admin"])) {
    addRead("Leave", LeaveRequest.find({})
      .select("reference employeeId requesterUserId approverUserId leaveType otherLeaveType reason startDate endDate requestedDays handoverName status decisions amendments createdAt")
      .populate("employeeId", "name firstName secondName otherNames department")
      .populate("amendments.decidedBy", "name")
      .sort({ createdAt: -1, _id: -1 }).limit(INBOX_LIMIT + 1).lean());
  } else {
    const employee = await Employee.findOne({ userId: actorId }).select("_id").lean();
    const leaveScope = [
      { requesterUserId: actorId },
      { approverUserId: actorId },
      ...(employee ? [{ employeeId: employee._id }, { handoverEmployeeId: employee._id }] : []),
    ];
    addRead("Leave", LeaveRequest.find({ $or: leaveScope })
      .select("reference employeeId requesterUserId approverUserId leaveType otherLeaveType reason startDate endDate requestedDays handoverName status decisions amendments createdAt")
      .populate("employeeId", "name firstName secondName otherNames department")
      .populate("amendments.decidedBy", "name")
      .sort({ createdAt: -1, _id: -1 }).limit(INBOX_LIMIT + 1).lean());
  }

  if (hasRole(user, READ_ROLES.salaryAdvances)) {
    addRead("Salary advance", SalaryAdvance.find({
      status: { $in: ["Pending HR review", "Pending GM review", "Approved", "Rejected", "Active", "Settled"] },
    }).select("reference employeeName requestedAmount proposedFrequency proposedInstallmentAmount reason dateTaken status hrDecision gmDecision createdBy requestedAt createdAt updatedAt")
      .sort({ requestedAt: -1, _id: -1 }).limit(INBOX_LIMIT + 1).lean());
  }
  if (hasRole(user, READ_ROLES.payroll)) {
    addRead("Payroll", PayrollRun.find({
      status: { $in: ["In review", "Manager approved", "Approved", "Returned", "Paid"] },
    }).select("reference runType periodStart periodEnd status approvals submittedAt updatedAt createdByName payslips.netPay returnedNote")
      .sort({ submittedAt: -1, _id: -1 }).limit(INBOX_LIMIT + 1).lean());
  }
  if (hasRole(user, READ_ROLES.expenses)) {
    addRead("Expense", Expense.find({ status: { $in: ["Pending approval", "Approved", "Rejected", "Partially paid", "Paid"] } })
      .select("reference status payee category department description date amount createdByName createdAt decisions")
      .sort({ createdAt: -1, _id: -1 }).limit(INBOX_LIMIT + 1).lean());
  }

  const canReadDisciplinary = hasRole(user, ["Human Resource", "General Manager"])
    || user.roles?.includes("Super Admin");
  if (canReadDisciplinary) {
    const disciplinaryFilter = user.roles?.includes("Human Resource")
      ? {}
      : user.roles?.includes("Super Admin")
        ? { "assignedApprovers.superAdmin": actorId }
        : { $or: [
          { "assignedApprovers.humanResource": actorId },
          { "assignedApprovers.generalManager": actorId },
          { "assignedApprovers.superAdmin": actorId },
        ] };
    addRead("Disciplinary", DisciplinaryCase.find({
      ...disciplinaryFilter,
      status: { $in: [
        "Pending Human Resource approval",
        "Pending General Manager approval",
        "Pending Super Admin approval",
        "Changes requested",
        "Approved",
        "Issued",
        "Closed",
        "Rescinded",
      ] },
    }).select("reference employeeName department type status incidentDate allegation reason response approvals approvalRound assignedApprovers createdBy createdAt updatedAt")
      .sort({ updatedAt: -1, _id: -1 }).limit(INBOX_LIMIT + 1).lean());
  }

  const results = await Promise.all(reads);
  const truncatedSources = readSources.filter((_source, index) => results[index].length > INBOX_LIMIT);
  const bySource = Object.fromEntries(readSources.map((source, index) => [source, results[index].slice(0, INBOX_LIMIT)]));
  const records = {
    leaves: bySource.Leave || [],
    advances: bySource["Salary advance"] || [],
    payrollRuns: bySource.Payroll || [],
    expenses: bySource.Expense || [],
    disciplinaryCases: bySource.Disciplinary || [],
  };

  const items = buildApprovalItems(records, user);
  return response.json({
    items,
    counts: {
      actionable: items.filter((item) => item.status === "Awaiting review").length,
      inProgress: items.filter((item) => item.status === "In progress").length,
      history: items.filter((item) => ["Approved", "Rejected", "Returned", "Cancelled"].includes(item.status)).length,
    },
    truncatedSources,
  });
}

module.exports = { buildApprovalItems, listApprovalInbox };
