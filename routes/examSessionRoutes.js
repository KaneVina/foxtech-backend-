const express = require("express");
const router = express.Router();
const examSessionController = require("../controllers/examSessionController");
const { verifyToken } = require("../middleware/authMiddleware");

// ─── Session (Giám thị) ───────────────────────────────────────────────────
router.post("/", verifyToken, examSessionController.createSession);
router.get("/:sessionCode", verifyToken, examSessionController.getSession);
router.delete("/:sessionCode", verifyToken, examSessionController.endSession);
router.post(
  "/:sessionCode/force-submit",
  verifyToken,
  examSessionController.forceSubmit,
);

// ─── Submission (Thí sinh) ────────────────────────────────────────────────
// QUAN TRỌNG: route tĩnh "join" phải khai báo TRƯỚC route động ":sessionCode"
router.post("/join", verifyToken, examSessionController.joinSession);
router.get(
  "/submission/:submissionId/status",
  verifyToken,
  examSessionController.getSubmissionStatus,
);
router.post(
  "/submission/:submissionId/submit",
  verifyToken,
  examSessionController.submitExam,
);

module.exports = router;
