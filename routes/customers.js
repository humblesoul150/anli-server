const express = require("express");
const controller = require("../controllers/customerController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const authenticated = [authenticate, requirePasswordChanged];
const readerRoles = ["Sales Manager", "Marketing Manager", "General Manager", "Admin"];
const managerRoles = ["Sales Manager", "General Manager", "Admin"];

function requireCustomerRole(roles, reason, message) {
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

const reader = requireCustomerRole(
  readerRoles,
  "customer_read_role_required",
  "You do not have permission to view customer records.",
);
const manager = requireCustomerRole(
  managerRoles,
  "customer_manage_role_required",
  "You do not have permission to manage customer records.",
);

router.get("/", ...authenticated, reader, controller.listCustomers);
router.post("/legacy-import", ...authenticated, manager, controller.importLegacyCustomers);
router.post("/", ...authenticated, manager, controller.createCustomer);
router.get("/:id", ...authenticated, reader, controller.getCustomer);
router.put("/:id", ...authenticated, manager, controller.updateCustomer);
router.patch("/:id/status", ...authenticated, manager, controller.changeCustomerStatus);
router.post("/:id/archive", ...authenticated, manager, controller.archiveCustomer);
router.post("/:id/restore", ...authenticated, manager, controller.restoreCustomer);

router.requireCustomerReader = reader;
router.requireCustomerManager = manager;
module.exports = router;
