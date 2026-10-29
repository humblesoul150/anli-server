const express = require("express");
const {
  listAccountEvents,
  listEventTypes,
  listEvents,
} = require("../controllers/auditController");
const {
  authenticate,
  requirePasswordChanged,
} = require("../middleware/authentication");
const { requireAnyRole } = require("../middleware/roleAccess");

const router = express.Router();
const overviewReader = [
  authenticate,
  requirePasswordChanged,
  requireAnyRole(
    ["General Manager", "Admin"],
    "overview_role_required",
    "You do not have permission to access auditing.",
  ),
];

router.get("/event-types", overviewReader, listEventTypes);
router.get("/", overviewReader, listEvents);
router.get("/users/:userId", overviewReader, listAccountEvents);

module.exports = router;
