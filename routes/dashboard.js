const express = require("express");
const { getDashboardSummary } = require("../controllers/dashboardController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");

const router = express.Router();

router.get("/summary", authenticate, requirePasswordChanged, getDashboardSummary);

module.exports = router;
