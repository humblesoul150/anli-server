const express = require("express");
const controller = require("../controllers/notificationController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const managers = ["General Manager", "Super Admin"];
async function requireManager(request, response, next) {
  if (hasAnyDepartmentRole(request.authUser, managers)) return next();
  await audit.recordAudit({
    request,
    eventType: "security.authorization_denied",
    outcome: "denied",
    reason: "credit_reminder_manager_required",
    actor: request.authUser,
    details: { resource: request.baseUrl },
  });
  return response.status(403).json({ error: "You do not have permission to manage credit reminder settings." });
}

router.use(authenticate, requirePasswordChanged);
router.get("/", controller.listNotifications);
router.get("/credit-reminder-settings", requireManager, controller.getReminderSettings);
router.put("/credit-reminder-settings", requireManager, controller.updateReminderSettings);
router.patch("/read-all", controller.markAllRead);
router.patch("/:id/read", controller.markRead);

module.exports = router;
