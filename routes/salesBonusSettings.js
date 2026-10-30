const express = require("express");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const { requireAnyRole } = require("../middleware/roleAccess");
const { getSettings, updateSettings } = require("../controllers/salesBonusSettingsController");

const router = express.Router();
const readerAndManager = [
  authenticate,
  requirePasswordChanged,
  requireAnyRole(
    ["Sales Manager", "General Manager", "Super Admin"],
    "sales_bonus_manager_required",
    "Only sales management roles can view or update sales bonus settings.",
  ),
];
const settingsManagers = [
  authenticate,
  requirePasswordChanged,
  requireAnyRole(
    ["General Manager", "Super Admin"],
    "sales_bonus_settings_manager_required",
    "Only General Manager and Super Admin can update sales bonus settings.",
  ),
];

router.get("/", ...readerAndManager, getSettings);
router.put("/", ...settingsManagers, updateSettings);

module.exports = router;
