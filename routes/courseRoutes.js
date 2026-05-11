const express = require("express");
const router = express.Router();
const cc = require("../controllers/courseController");
const { verifyToken } = require("../middleware/authMiddleware");
const checkRole = require("../middleware/roleMiddleware");

const canManage = checkRole(["admin", "leader", "action leader"]);

// ─── Metadata (tags) ──────────────────────────────────────────
router.get("/metadata", verifyToken, cc.getTagMetadata);

// ─── Courses ──────────────────────────────────────────────────
router.get("/", verifyToken, cc.getCourses);
router.get("/:id", verifyToken, cc.getCourseDetail);
router.post("/", verifyToken, canManage, cc.createCourse);
router.put("/:id", verifyToken, canManage, cc.updateCourse);
router.delete("/:id", verifyToken, canManage, cc.deleteCourse);

// ─── Video token (bảo vệ YouTube URL) ────────────────────────
router.get("/:id/lesson/:lessonId/video", verifyToken, cc.getLessonVideo);
router.get(
  "/:id/lesson/:lessonId/resources",
  verifyToken,
  cc.getLessonResources,
);

// ─── Sections ─────────────────────────────────────────────────
router.post("/:id/sections", verifyToken, canManage, cc.createSection);
router.put("/sections/:sectionId", verifyToken, canManage, cc.updateSection);
router.delete("/sections/:sectionId", verifyToken, canManage, cc.deleteSection);

// ─── Lessons ──────────────────────────────────────────────────
router.post(
  "/sections/:sectionId/lessons",
  verifyToken,
  canManage,
  cc.createLesson,
);
router.put("/lessons/:lessonId", verifyToken, canManage, cc.updateLesson);
router.delete("/lessons/:lessonId", verifyToken, canManage, cc.deleteLesson);

// ─── Progress ─────────────────────────────────────────────────
router.post("/progress/watch", verifyToken, cc.saveWatchProgress);
router.put("/progress/:lessonId/complete", verifyToken, cc.markLessonComplete);

module.exports = router;
