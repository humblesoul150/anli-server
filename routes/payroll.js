const express = require("express");
const controller = require("../controllers/payrollController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const authenticated = [authenticate, requirePasswordChanged];

function requireRole(roles, reason, message) {
  return async (request, response, next) => {
    if (hasAnyDepartmentRole(request.authUser, roles)) return next();
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason,
      actor: request.authUser,
      details: { resource: request.baseUrl },
    });
    return response.status(403).json({ error: message });
  };
}

const reader = requireRole(
  ["Human Resource", "General Manager", "Super Admin", "Admin"],
  "payroll_read_role_required",
  "You do not have permission to view payroll.",
);
const preparer = requireRole(
  ["Human Resource"],
  "payroll_prepare_role_required",
  "Only Human Resource can prepare payroll runs.",
);
const policyWriter = requireRole(
  ["Super Admin"],
  "payroll_policy_role_required",
  "Only a Super Admin can configure payroll policy.",
);
const approver = requireRole(
  ["General Manager", "Super Admin"],
  "payroll_approval_role_required",
  "Only the assigned General Manager or Super Admin can approve payroll.",
);
const cashier = requireRole(
  ["Super Admin"],
  "payroll_payment_role_required",
  "Only a Super Admin can record payroll cash payouts.",
);
const attendanceCloser = requireRole(
  ["Human Resource"],
  "attendance_period_close_role_required",
  "Only Human Resource can certify and close attendance periods.",
);
const attendanceReopener = requireRole(
  ["Super Admin"],
  "attendance_period_reopen_role_required",
  "Only a Super Admin can reopen a certified attendance period.",
);

router.get("/policy", ...authenticated, reader, controller.listPolicy);
router.put("/policy", ...authenticated, policyWriter, controller.updatePolicy);
router.get("/runs", ...authenticated, reader, controller.listRuns);
router.post("/runs", ...authenticated, preparer, controller.createRun);
router.get("/runs/:id", ...authenticated, reader, controller.getRun);
router.post("/runs/:id/recalculate", ...authenticated, preparer, controller.recalculateRun);
router.post("/runs/:id/submit", ...authenticated, preparer, controller.submitRun);
router.post("/runs/:id/decision", ...authenticated, approver, controller.decideRun);
router.post("/runs/:id/payment", ...authenticated, cashier, controller.recordPayment);
router.get("/attendance-periods/:periodStart/:periodEnd", ...authenticated, reader, controller.getAttendancePeriod);
router.post("/attendance-periods", ...authenticated, attendanceCloser, controller.closeAttendancePeriod);
router.post("/attendance-periods/:periodStart/:periodEnd/reopen", ...authenticated, attendanceReopener, controller.reopenAttendancePeriod);
router.get("/employees/:employeeId/payslips", ...authenticated, controller.listPayslips);

router.requirePayrollReader = reader;
router.requirePayrollPreparer = preparer;
router.requirePayrollPolicyWriter = policyWriter;
router.requirePayrollApprover = approver;
router.requirePayrollCashier = cashier;
module.exports = router;
