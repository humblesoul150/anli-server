const express = require("express");
const {
  listAttendance,
  saveDailyAttendance,
} = require("../controllers/attendanceController");
const {
  authenticate,
  requirePasswordChanged,
} = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const allowedRoles = ["Super Admin", "Admin", "Human Resource"];

async function requireAttendanceRole(request, response, next) {
  if (hasAnyDepartmentRole(request.authUser, allowedRoles)) return next();
  await audit.recordAudit({
    request,
    eventType: "security.authorization_denied",
    outcome: "denied",
    reason: "attendance_role_required",
    actor: request.authUser,
    details: { resource: request.baseUrl },
  });
  return response.status(403).json({ error: "You do not have permission to access attendance records." });
}

const authorized = [authenticate, requirePasswordChanged, requireAttendanceRole];

router.get("/", authorized, listAttendance);
router.put("/daily/:workDate", authorized, saveDailyAttendance);

router.requireAttendanceRole = requireAttendanceRole;
module.exports = router;
