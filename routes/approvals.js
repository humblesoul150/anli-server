const express = require("express");
const { listApprovalInbox } = require("../controllers/approvalsController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");

const router = express.Router();

router.get("/", authenticate, requirePasswordChanged, listApprovalInbox);

module.exports = router;
