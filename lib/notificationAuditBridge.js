const LeaveRequest = require("../models/leaveRequest");
const PayrollRun = require("../models/payrollRun");
const SalaryAdvance = require("../models/salaryAdvance");
const Expense = require("../models/expense");
const Employee = require("../models/employee");
const DisciplinaryCase = require("../models/disciplinaryCase");
const { enqueueNotificationEvent } = require("./notificationEvents");

const CREDIT_SAFE_EVENTS = new Set([
  "leave.requested",
  "leave.approved",
  "leave.rejected",
  "leave.cancelled",
  "leave.amendment_requested",
  "leave.amendment_approved",
  "leave.amendment_rejected",
  "leave.return_confirmed",
  "payroll.run_submitted",
  "payroll.run_decided",
  "payroll.payment_recorded",
  "expense.created",
  "expense.approved",
  "expense.rejected",
  "expense.payment_recorded",
  "salary_advance.requested",
  "salary_advance.hr_approved",
  "salary_advance.gm_approved",
  "salary_advance.rejected",
  "salary_advance.disbursed",
  "disciplinary.response_requested",
  "disciplinary.response_submitted",
  "disciplinary.no_response_recorded",
  "disciplinary.approved",
  "disciplinary.rejected",
  "disciplinary.issued",
  "disciplinary.appealed",
]);

function referenceFor(record, fallback) {
  return record.reference || record.receiptNumber || fallback;
}

async function enqueueFromAudit(event, transaction) {
  if (event.outcome !== "success" || !CREDIT_SAFE_EVENTS.has(event.eventType)) return;
  const details = event.details || {};
  const actorId = event.actorId ? String(event.actorId) : null;
  let category;
  let type = event.eventType;
  let title;
  let message;
  let resource;
  let recipientIds = [];
  let recipientRoles = [];
  let severity = "info";

  if (event.eventType.startsWith("leave.")) {
    const leave = await LeaveRequest.findById(details.leaveRequestId).session(transaction).lean();
    if (!leave) return;
    category = "leave";
    resource = { type: "leave_request", id: String(leave._id), reference: `Leave ${leave.startDate}` };
    if (event.eventType === "leave.requested" || event.eventType === "leave.amendment_requested") {
      recipientIds = [leave.approverUserId];
      title = "Leave request needs review";
      message = "A leave request is waiting for your decision.";
      severity = "action_required";
    } else {
      recipientIds = [leave.employeeUserId || leave.createdBy];
      if (event.eventType.includes("approved")) {
        title = "Leave request approved";
        message = "Your leave request has been approved.";
      } else if (event.eventType.includes("rejected")) {
        title = "Leave request update";
        message = "A decision has been recorded for your leave request.";
      } else if (event.eventType === "leave.cancelled") {
        recipientIds = [leave.approverUserId];
        title = "Leave request cancelled";
        message = "A leave request has been cancelled.";
      } else if (event.eventType === "leave.return_confirmed") {
        recipientIds = [leave.approverUserId];
        title = "Return from leave confirmed";
        message = "An employee's return from leave has been confirmed.";
      } else {
        return;
      }
    }
  } else if (event.eventType.startsWith("expense.")) {
    const expense = await Expense.findById(details.expenseId).session(transaction).lean();
    if (!expense) return;
    category = "expense";
    resource = { type: "expense", id: String(expense._id), reference: referenceFor(expense, "Expense") };
    if (event.eventType === "expense.created") {
      recipientRoles = ["General Manager"];
      title = "Expense needs approval";
      message = "An expense is waiting for your decision.";
      severity = "action_required";
    } else {
      recipientIds = [expense.createdBy];
      if (event.eventType === "expense.approved") {
        title = "Expense approved";
        message = "Your submitted expense has been approved.";
      } else if (event.eventType === "expense.rejected") {
        title = "Expense decision recorded";
        message = "A decision has been recorded for your submitted expense.";
      } else {
        title = "Expense payment recorded";
        message = "A payment has been recorded for your expense.";
      }
    }
  } else if (event.eventType.startsWith("payroll.")) {
    const run = await PayrollRun.findById(details.runId).session(transaction).lean();
    if (!run) return;
    category = "payroll";
    resource = { type: "payroll_run", id: String(run._id), reference: run.reference };
    if (event.eventType === "payroll.run_submitted") {
      recipientRoles = ["General Manager"];
      title = "Payroll run needs approval";
      message = "A payroll run is ready for your review.";
      severity = "action_required";
    } else if (event.eventType === "payroll.run_decided" && run.status === "Manager approved") {
      recipientRoles = ["Super Admin"];
      title = "Payroll run needs final approval";
      message = "A payroll run is ready for final review.";
      severity = "action_required";
    } else if (event.eventType === "payroll.run_decided") {
      recipientIds = [run.createdBy];
      title = run.status === "Returned" ? "Payroll returned for changes" : "Payroll run approved";
      message = run.status === "Returned"
        ? "Your payroll run was returned for changes."
        : "Your payroll run has completed its approval stages.";
    } else {
      recipientIds = [run.createdBy];
      const employees = await Employee.find({ _id: { $in: run.payslips.map((slip) => slip.employeeId) }, status: "Active" })
        .select("userId").session(transaction).lean();
      recipientIds.push(...employees.map((employee) => employee.userId).filter(Boolean));
      title = "Payroll payment recorded";
      message = "Payroll payment was recorded and your payslip is available.";
    }
  } else if (event.eventType.startsWith("salary_advance.")) {
    const advance = await SalaryAdvance.findById(details.advanceId).session(transaction).lean();
    if (!advance) return;
    const employee = await Employee.findById(advance.employeeId).select("userId").session(transaction).lean();
    const employeeUserId = employee?.userId ? String(employee.userId) : null;
    category = "salary_advance";
    resource = { type: "salary_advance", id: String(advance._id), reference: advance.reference };
    if (event.eventType === "salary_advance.requested") {
      recipientRoles = ["Human Resource"];
      title = "Salary advance needs review";
      message = "A salary advance request is waiting for HR review.";
      severity = "action_required";
    } else if (event.eventType === "salary_advance.hr_approved") {
      recipientRoles = ["General Manager"];
      title = "Salary advance needs final review";
      message = "A salary advance is ready for General Manager review.";
      severity = "action_required";
    } else if (event.eventType === "salary_advance.gm_approved") {
      recipientIds = [advance.createdBy, employeeUserId];
      title = "Salary advance approved";
      message = "A salary advance request has been approved.";
    } else if (event.eventType === "salary_advance.rejected") {
      recipientIds = [advance.createdBy, employeeUserId];
      title = "Salary advance decision recorded";
      message = "A decision has been recorded for a salary advance request.";
    } else if (event.eventType === "salary_advance.disbursed") {
      recipientIds = [employeeUserId];
      title = "Salary advance disbursed";
      message = "Your approved salary advance has been disbursed.";
    } else {
      return;
    }
  } else if (event.eventType.startsWith("disciplinary.")) {
    const caseRecord = await DisciplinaryCase.findById(details.caseId).session(transaction).lean();
    if (!caseRecord) return;
    category = "approval";
    resource = { type: "disciplinary_case", id: String(caseRecord._id), reference: caseRecord.reference };
    const statusStage = {
      "Pending Human Resource approval": "humanResource",
      "Pending General Manager approval": "generalManager",
      "Pending Super Admin approval": "superAdmin",
    };
    if (event.eventType === "disciplinary.response_requested") {
      recipientIds = [caseRecord.employeeUserId || caseRecord.createdBy];
      title = "Action required: workplace case";
      message = "A confidential workplace matter requires your response.";
      severity = "action_required";
    } else if (event.eventType === "disciplinary.response_submitted" ||
      event.eventType === "disciplinary.no_response_recorded") {
      recipientIds = [caseRecord.assignedApprovers?.humanResource];
      title = "Workplace case ready for review";
      message = "A confidential workplace case is ready for your review.";
      severity = "action_required";
    } else if (event.eventType === "disciplinary.approved" && statusStage[caseRecord.status]) {
      recipientIds = [caseRecord.assignedApprovers?.[statusStage[caseRecord.status]]];
      title = "Workplace case needs approval";
      message = "A confidential workplace case is ready for your review.";
      severity = "action_required";
    } else if (event.eventType === "disciplinary.rejected" || event.eventType === "disciplinary.issued") {
      recipientIds = [caseRecord.employeeUserId || caseRecord.createdBy];
      title = "Workplace case update";
      message = "There is an update to a confidential workplace matter.";
    } else if (event.eventType === "disciplinary.appealed") {
      recipientIds = [caseRecord.createdBy];
      title = "Workplace case appeal submitted";
      message = "An appeal has been submitted for a confidential case.";
      severity = "action_required";
    } else {
      return;
    }
  } else {
    return;
  }

  const normalizedIds = [...new Set(recipientIds.filter(Boolean).map(String))];
  if (actorId && !recipientRoles.length) normalizedIds.splice(0, normalizedIds.length, ...normalizedIds.filter((id) => id !== actorId));
  if (!normalizedIds.length && !recipientRoles.length) return;
  const eventId = String(event._id);
  await enqueueNotificationEvent({
    eventKey: `audit:${eventId}`,
    type,
    category,
    severity,
    title,
    message,
    resource,
    actorId,
    recipientIds: normalizedIds,
    recipientRoles,
    excludeRecipientIds: actorId ? [actorId] : [],
    occurredAt: event.createdAt,
  }, transaction);
}

module.exports = { enqueueFromAudit };
