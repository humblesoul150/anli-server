const express = require("express");
const controller = require("../controllers/salesController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

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
  return response.status(403).json({ error: "You do not have permission to access sales records." });
}

router.use(authenticate, requirePasswordChanged, requireSalesRole);
router.get("/", controller.listSales);
router.post("/legacy-import", controller.importLegacySales);
router.post("/", controller.createSale);
router.get("/owners", controller.listSalesOwners);
router.get("/credit-customers/:customerId/statement", controller.getCreditStatement);
router.get("/:id", controller.getSale);
router.patch("/:id/credit", controller.updateCreditSale);
router.post("/:id/payments", controller.recordPayment);

router.requireSalesRole = requireSalesRole;
module.exports = router;
