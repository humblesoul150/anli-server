const express = require("express");
const controller = require("../controllers/receiptManagementController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const { hasAnyDepartmentRole } = require("../lib/authorization");
const audit = require("../lib/audit");

const router = express.Router();
const salesRoles = ["Sales Manager", "General Manager", "Super Admin"];

async function requireSalesRole(request, response, next) {
  if (hasAnyDepartmentRole(request.authUser, salesRoles)) return next();
  await audit.recordAudit({
    request,
    eventType: "security.authorization_denied",
    outcome: "denied",
    reason: "sales_role_required",
    actor: request.authUser,
    details: { resource: request.baseUrl },
  });
  return response.status(403).json({ error: "You do not have permission to access receipts." });
}

router.use(authenticate, requirePasswordChanged, requireSalesRole);
router.get("/:kind", controller.listReceipts);
router.post("/bulk-export", controller.recordBulkExport);
router.patch("/:kind/:id/favorite", controller.setFavorite);
router.patch("/:kind/:id/archive", controller.setArchived);

module.exports = router;
