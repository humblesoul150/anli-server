const express = require("express");
const multer = require("multer");
const controller = require("../controllers/expenseController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const authenticated = [authenticate, requirePasswordChanged];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
});

function requireExpenseRole(roles, reason, message) {
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

const reader = requireExpenseRole(
  ["Accountant", "General Manager", "Admin", "Super Admin"],
  "expense_read_role_required",
  "You do not have permission to view expenses.",
);
const accountant = requireExpenseRole(
  ["Accountant", "General Manager"],
  "expense_accountant_role_required",
  "Only an Accountant or General Manager can manage expense records.",
);
const manager = requireExpenseRole(
  ["General Manager"],
  "expense_approval_role_required",
  "Only the General Manager can approve or reject expenses.",
);

function parseReceipt(request, response, next) {
  upload.single("receipt")(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return response.status(400).json({ error: "Receipt images must be 5 MB or smaller." });
    }
    return response.status(400).json({ error: "The receipt upload could not be read." });
  });
}

router.get("/", ...authenticated, reader, controller.listExpenses);
router.post("/legacy-import", ...authenticated, accountant, controller.importLegacyExpenses);
router.post("/", ...authenticated, accountant, controller.createExpense);
router.get("/:id", ...authenticated, reader, controller.getExpense);
router.get("/:id/attachments/:attachmentId/download", ...authenticated, reader, controller.getAttachmentDownload);
router.post("/:id/decision", ...authenticated, manager, controller.decideExpense);
router.post("/:id/payments", ...authenticated, accountant, controller.recordPayment);
router.post("/:id/attachments", ...authenticated, accountant, parseReceipt, controller.uploadAttachment);
router.delete("/:id/attachments/:attachmentId", ...authenticated, accountant, controller.removeAttachment);

router.requireExpenseReader = reader;
router.requireExpenseAccountant = accountant;
router.requireExpenseManager = manager;
module.exports = router;
