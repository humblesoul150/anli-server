const express = require("express");
const multer = require("multer");
const {
  createEmployee,
  deactivateEmployee,
  deleteDraft,
  getEmployee,
  getEmployeeDocumentDownload,
  importEmployees,
  listDrafts,
  listEmployees,
  removeEmployeeDocument,
  removeEmployeeImage,
  saveDraft,
  updateEmployee,
  uploadEmployeeDocument,
  uploadEmployeeImage,
} = require("../controllers/employeeController");
const {
  authenticate,
  requirePasswordChanged,
} = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const employeeRoles = ["Super Admin", "Admin", "Human Resource", "General Manager"];
const managerRoles = ["Super Admin", "Admin", "Human Resource"];
const authenticated = [authenticate, requirePasswordChanged];
const reader = [...authenticated, requireRoles(employeeRoles)];
const manager = [...authenticated, requireRoles(managerRoles)];
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function requireRoles(allowedRoles) {
  return async (request, response, next) => {
    if (hasAnyDepartmentRole(request.authUser, allowedRoles)) return next();
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason: "employee_role_required",
      actor: request.authUser,
      details: { resource: request.baseUrl },
    });
    return response.status(403).json({ error: "You do not have permission to access employee profiles." });
  };
}

function parseUpload(upload, field, maxLabel) {
  return (request, response, next) => {
    upload.single(field)(request, response, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        return response.status(400).json({ error: `The uploaded file must be ${maxLabel} or smaller.` });
      }
      return response.status(400).json({ error: "The uploaded file could not be read." });
    });
  };
}

router.get("/", reader, listEmployees);
router.post("/", manager, createEmployee);
router.post("/import", manager, importEmployees);
router.get("/drafts", manager, listDrafts);
router.put("/drafts/:draftId", manager, saveDraft);
router.delete("/drafts/:draftId", manager, deleteDraft);
router.get("/:id/documents/:documentId/download", manager, getEmployeeDocumentDownload);
router.get("/:id", reader, getEmployee);
router.put("/:id", manager, updateEmployee);
router.delete("/:id", manager, deactivateEmployee);
router.post("/:id/image", manager, parseUpload(imageUpload, "image", "5 MB"), uploadEmployeeImage);
router.delete("/:id/image", manager, removeEmployeeImage);
router.post("/:id/documents", manager, parseUpload(documentUpload, "document", "10 MB"), uploadEmployeeDocument);
router.delete("/:id/documents/:documentId", manager, removeEmployeeDocument);

module.exports = router;
