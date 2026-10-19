const express = require("express");
const multer = require("multer");
const {
  addManualRepayment,
  createSalaryAdvance,
  decideGeneralManager,
  decideHr,
  getSalaryAdvance,
  importLegacySalaryAdvances,
  listSalaryAdvances,
  previewLegacySalaryAdvances,
  recordDisbursement,
  recordPayrollRepayments,
} = require("../controllers/salaryAdvanceController");
const {
  addAttachment,
  getAttachmentDownload,
  removeAttachment,
} = require("../controllers/salaryAdvanceAttachmentController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");

const router = express.Router();
const authenticated = [authenticate, requirePasswordChanged];
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function requireRole(roles, reason, message) {
  return async (request, response, next) => {
    if (request.authUser.roles.some((role) => roles.includes(role))) return next();
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

const requireAdvanceRead = requireRole(
  ["Human Resource", "General Manager", "Admin", "Super Admin"],
  "salary_advance_read_role_required",
  "You do not have permission to read salary advances.",
);
const requireHrManager = requireRole(
  ["Human Resource"],
  "salary_advance_hr_role_required",
  "Only Human Resource can perform this salary-advance action.",
);
const requireGeneralManager = requireRole(
  ["General Manager"],
  "salary_advance_gm_role_required",
  "Only the General Manager can finalize salary-advance approvals.",
);
const requirePayrollManager = requireRole(
  ["Human Resource", "Accountant"],
  "salary_advance_payroll_role_required",
  "You do not have permission to post payroll repayments.",
);
const reader = [...authenticated, requireAdvanceRead];
const hrManager = [...authenticated, requireHrManager];
const generalManager = [...authenticated, requireGeneralManager];
const payrollManager = [...authenticated, requirePayrollManager];

function parseAttachment(request, response, next) {
  attachmentUpload.single("file")(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return response.status(400).json({ error: "An attachment must be 10 MB or smaller." });
    }
    return response.status(400).json({ error: "The attachment could not be read." });
  });
}

router.get("/", reader, listSalaryAdvances);
router.post("/", hrManager, createSalaryAdvance);
router.post("/legacy-import/preview", hrManager, previewLegacySalaryAdvances);
router.post("/legacy-import", hrManager, importLegacySalaryAdvances);
router.post("/payroll-repayments", payrollManager, recordPayrollRepayments);
router.get("/:id", reader, getSalaryAdvance);
router.post("/:id/hr-decision", hrManager, decideHr);
router.post("/:id/gm-decision", generalManager, decideGeneralManager);
router.post("/:id/disbursement", hrManager, recordDisbursement);
router.post("/:id/repayments", hrManager, addManualRepayment);
router.post("/:id/attachments", hrManager, parseAttachment, addAttachment);
router.delete("/:id/attachments/:attachmentId", hrManager, removeAttachment);
router.get("/:id/attachments/:attachmentId/download", reader, getAttachmentDownload);

router.requireAdvanceRead = requireAdvanceRead;
router.requireHrManager = requireHrManager;
router.requireGeneralManager = requireGeneralManager;
router.requirePayrollManager = requirePayrollManager;
module.exports = router;
