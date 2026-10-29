const express = require("express");
const controller = require("../controllers/receiptManagementController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const { hasAnyDepartmentRole } = require("../lib/authorization");
const audit = require("../lib/audit");

const router = express.Router();
const readerRoles = ["Sales Manager", "General Manager", "Admin", "Super Admin"];
const writerRoles = ["Sales Manager", "General Manager", "Super Admin"];

function requireSalesRole(roles, reason, message) {
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

const reader = requireSalesRole(
  readerRoles,
  "receipt_read_role_required",
  "You do not have permission to access receipts.",
);
const writer = requireSalesRole(
  writerRoles,
  "receipt_write_role_required",
  "You do not have permission to modify receipts.",
);

router.use(authenticate, requirePasswordChanged);
router.get("/:kind", reader, controller.listReceipts);
router.post("/bulk-export", reader, controller.recordBulkExport);
router.patch("/:kind/:id/favorite", writer, controller.setFavorite);
router.patch("/:kind/:id/archive", writer, controller.setArchived);

module.exports = router;
