const express = require("express");
const { listApprovalInbox } = require("../controllers/approvalsController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const { requireAnyRole } = require("../middleware/roleAccess");

const router = express.Router();
const overviewReader = requireAnyRole(
  ["General Manager", "Admin"],
  "overview_role_required",
  "You do not have permission to access approvals.",
);

router.get("/", authenticate, requirePasswordChanged, overviewReader, listApprovalInbox);

module.exports = router;
