const express = require("express");
const controller = require("../controllers/ordersController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const readerRoles = ["Sales Manager", "Marketing Manager", "General Manager", "Admin", "Super Admin"];
const writerRoles = ["Sales Manager", "General Manager", "Super Admin"];

function requireOrderRole(roles, reason, message) {
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

const reader = requireOrderRole(
  readerRoles,
  "order_read_role_required",
  "You do not have permission to access order records.",
);
const writer = requireOrderRole(
  writerRoles,
  "order_write_role_required",
  "You do not have permission to change order records.",
);

router.use(authenticate, requirePasswordChanged);

router.get("/", reader, controller.listOrders);
router.post("/legacy-import", writer, controller.importLegacyOrders);
router.post("/", writer, controller.createOrder);
router.get("/:id", reader, controller.getOrder);
router.put("/:id", writer, controller.updateOrder);
router.post("/:id/confirm", writer, controller.confirmOrder);
router.patch("/:id/status", writer, controller.changeOrderStatus);
router.post("/:id/payments", writer, controller.recordOrderPayment);
router.post("/:id/fulfill", writer, controller.fulfillOrder);
router.post("/:id/archive", writer, controller.archiveOrder);
router.post("/:id/restore", writer, controller.restoreOrder);

module.exports = router;
