const express = require("express");
const multer = require("multer");
const {
  getProfile,
  getPublicBrand,
  removeCompanyLogo,
  updateProfile,
  uploadCompanyLogo,
} = require("../controllers/profileSettingsController");
const {
  authenticate,
  requirePasswordChanged,
  requireSuperAdmin,
} = require("../middleware/authentication");

const router = express.Router();
const superAdminOnly = [authenticate, requireSuperAdmin, requirePasswordChanged];
const authenticatedUser = [authenticate, requirePasswordChanged];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

function parseLogoUpload(request, response, next) {
  upload.single("logo")(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return response.status(400).json({ error: "Logo images must be 2 MB or smaller." });
    }
    return response.status(400).json({ error: "The logo upload could not be read." });
  });
}

router.get("/public-brand", getPublicBrand);
router.get("/", authenticatedUser, getProfile);
router.put("/", superAdminOnly, updateProfile);
router.post("/logo", superAdminOnly, parseLogoUpload, uploadCompanyLogo);
router.delete("/logo", superAdminOnly, removeCompanyLogo);

module.exports = router;
