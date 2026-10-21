const express = require("express");
const multer = require("multer");
const controller = require("../controllers/disciplinaryController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");

const router = express.Router();
const authenticated = [authenticate, requirePasswordChanged];
const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function parseEvidence(request, response, next) {
  evidenceUpload.single("file")(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "Evidence files must be 10 MB or smaller."
        : "Provide exactly one evidence file.";
      return response.status(400).json({ error: message });
    }
    return next(error);
  });
}

router.get("/policy", authenticated, controller.getDisciplinaryPolicy);
router.put("/policy", authenticated, controller.updateDisciplinaryPolicy);
router.get("/approvers", authenticated, controller.listApproverCandidates);
router.get("/employee-indicators", authenticated, controller.listEmployeeIndicators);
router.get("/my-cases", authenticated, controller.listEmployeeCases);
router.get("/my-cases/:caseId", authenticated, controller.getEmployeeCase);
router.post("/my-cases/:caseId/responses", authenticated, controller.submitEmployeeResponse);
router.post("/my-cases/:caseId/acknowledgements", authenticated, controller.acknowledgeLetter);
router.post("/my-cases/:caseId/appeals", authenticated, controller.submitAppeal);
router.get("/", authenticated, controller.listCases);
router.post("/", authenticated, controller.createCase);
router.get("/:caseId", authenticated, controller.getCase);
router.patch("/:caseId", authenticated, controller.updateCase);
router.post("/:caseId/response-request", authenticated, controller.requestEmployeeResponse);
router.post("/:caseId/response-record", authenticated, controller.recordOfflineResponse);
router.post("/:caseId/no-response", authenticated, controller.recordNoResponse);
router.post("/:caseId/submit", authenticated, controller.submitForApproval);
router.post("/:caseId/approvals", authenticated, controller.decideApproval);
router.post("/:caseId/issue", authenticated, controller.issueCase);
router.post("/:caseId/appeals/:appealId/resolution", authenticated, controller.resolveAppeal);
router.post("/:caseId/rescind", authenticated, controller.rescindCase);
router.post("/:caseId/evidence", ...authenticated, parseEvidence, controller.addEvidence);
router.delete("/:caseId/evidence/:evidenceId", authenticated, controller.removeEvidence);
router.get("/:caseId/evidence/:evidenceId/download", authenticated, controller.downloadEvidence);

module.exports = router;
