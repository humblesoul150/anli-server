const express = require("express");
const {
  cancelLeaveRequest,
  confirmLeaveReturn,
  createLeaveRequest,
  decideLeaveAmendment,
  decideLeaveRequest,
  getBalances,
  getLeavePolicy,
  listLeavePeople,
  listLegacyLeaveArchive,
  listReminderCandidates,
  listLeaveRequests,
  importLegacyLeaveRequests,
  previewLegacyLeaveRequests,
  requestLeaveAmendment,
  updateLeavePolicy,
  updateLeaveRouting,
} = require("../controllers/leaveController");
const {
  authenticate,
  requirePasswordChanged,
  requireSuperAdmin,
} = require("../middleware/authentication");

const router = express.Router();
const authenticated = [authenticate, requirePasswordChanged];

router.get("/policy", authenticated, getLeavePolicy);
router.put("/policy", ...authenticated, requireSuperAdmin, updateLeavePolicy);
router.get("/people", authenticated, listLeavePeople);
router.put("/people/:employeeId/routing", authenticated, updateLeaveRouting);
router.get("/legacy-archive", authenticated, listLegacyLeaveArchive);
router.post("/legacy-import/preview", authenticated, previewLegacyLeaveRequests);
router.post("/legacy-import", authenticated, importLegacyLeaveRequests);
router.get("/balances", authenticated, getBalances);
router.get("/reminder-candidates", authenticated, listReminderCandidates);
router.get("/", authenticated, listLeaveRequests);
router.post("/", authenticated, createLeaveRequest);
router.post("/:id/decision", authenticated, decideLeaveRequest);
router.post("/:id/cancel", authenticated, cancelLeaveRequest);
router.post("/:id/amendments", authenticated, requestLeaveAmendment);
router.post("/:id/amendments/:amendmentId/decision", authenticated, decideLeaveAmendment);
router.post("/:id/return-confirmation", authenticated, confirmLeaveReturn);

module.exports = router;
