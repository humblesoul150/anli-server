const express = require("express");
const { getDashboardSummary } = require("../controllers/dashboardController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const { requireAnyRole } = require("../middleware/roleAccess");

const router = express.Router();
const overviewReader = requireAnyRole(
  ["General Manager", "Admin"],
  "overview_role_required",
  "You do not have permission to access the overview.",
);

router.get("/summary", authenticate, requirePasswordChanged, overviewReader, getDashboardSummary);

module.exports = router;
