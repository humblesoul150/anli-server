const express = require("express");
const { listAccountEvents, listEvents } = require("../controllers/auditController");
const {
  authenticate,
  requirePasswordChanged,
  requireSuperAdmin,
} = require("../middleware/authentication");

const router = express.Router();
const superAdminOnly = [authenticate, requireSuperAdmin, requirePasswordChanged];

router.get("/", superAdminOnly, listEvents);
router.get("/users/:userId", superAdminOnly, listAccountEvents);

module.exports = router;
