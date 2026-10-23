const express = require("express");
const controller = require("../controllers/ordersController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const roles = ["Sales Manager", "General Manager", "Super Admin"];

async function requireOrderRole(request, response, next) {
  if (hasAnyDepartmentRole(request.authUser, roles)) return next();
  await audit.recordAudit({
    request,
    eventType: "security.authorization_denied",
    outcome: "denied",
    reason: "order_role_required",
    actor: request.authUser,
    details: { resource: request.baseUrl },
  });
  return response.status(403).json({ error: "You do not have permission to access order records." });
}

router.use(authenticate, requirePasswordChanged, requireOrderRole);
router.get("/", controller.listOrders);
router.post("/legacy-import", controller.importLegacyOrders);
router.post("/", controller.createOrder);
router.get("/:id", controller.getOrder);
router.put("/:id", controller.updateOrder);
router.post("/:id/confirm", controller.confirmOrder);
router.patch("/:id/status", controller.changeOrderStatus);
router.post("/:id/payments", controller.recordOrderPayment);
router.post("/:id/fulfill", controller.fulfillOrder);
router.post("/:id/archive", controller.archiveOrder);
router.post("/:id/restore", controller.restoreOrder);

module.exports = router;
