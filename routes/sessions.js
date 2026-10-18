const express = require("express");
const {
  listOwnSessions,
  listUserSessions,
  reportActivity,
  revokeSession,
} = require("../controllers/sessionController");
const {
  authenticate,
  requirePasswordChanged,
  requireSuperAdmin,
} = require("../middleware/authentication");

const router = express.Router();
const authenticated = [authenticate, requirePasswordChanged];

router.post("/activity", authenticate, reportActivity);
router.get("/", authenticated, listOwnSessions);
router.get("/users/:userId", [...authenticated, requireSuperAdmin], listUserSessions);
router.delete("/:sessionId", authenticated, revokeSession);

module.exports = router;
