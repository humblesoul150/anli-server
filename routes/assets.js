const express = require("express");
const multer = require("multer");
const controller = require("../controllers/companyAssetController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const readerRoles = ["Inventory Manager", "General Manager", "Admin", "Super Admin"];
const writerRoles = ["Inventory Manager"];
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
});

function requireAssetRoles(allowedRoles, reason, message) {
  return async (request, response, next) => {
    if (hasAnyDepartmentRole(request.authUser, allowedRoles)) return next();
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

const authenticated = [authenticate, requirePasswordChanged];
const access = requireAssetRoles(
  readerRoles,
  "asset_role_required",
  "You do not have permission to access company assets.",
);
const reader = [...authenticated, access];
const writer = [
  ...authenticated,
  access,
  requireAssetRoles(
    writerRoles,
    "asset_write_role_required",
    "Only Inventory Managers can change company assets.",
  ),
];

function parsePhotoUpload(request, response, next) {
  photoUpload.single("photo")(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return response.status(400).json({ error: "Asset photos must be 5 MB or smaller." });
    }
    return response.status(400).json({ error: "The asset photo upload could not be read." });
  });
}

router.get("/", reader, controller.listAssets);
router.get("/:id", reader, controller.getAsset);
router.post("/", writer, controller.createAsset);
router.post("/import", writer, controller.importAssets);
router.patch("/:id", writer, controller.updateAsset);
router.post("/:id/events", writer, controller.recordAssetEvent);
router.post("/:id/photos", writer, parsePhotoUpload, controller.uploadAssetPhoto);
router.delete("/:id/photos/:photoId", writer, controller.deleteAssetPhoto);

router.requireAssetAccess = access;
router.requireAssetWriter = writer[writer.length - 1];
module.exports = router;
