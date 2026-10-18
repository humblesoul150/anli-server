const express = require("express");
const {
  getSettings,
  updateSettings,
} = require("../controllers/securitySettingsController");
const {
  authenticate,
  requirePasswordChanged,
  requireSuperAdmin,
} = require("../middleware/authentication");

const router = express.Router();
const superAdminOnly = [authenticate, requireSuperAdmin, requirePasswordChanged];

router.get("/", superAdminOnly, getSettings);
router.put("/", superAdminOnly, updateSettings);

module.exports = router;
