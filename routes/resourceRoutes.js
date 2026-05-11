const express = require("express");
const router = express.Router();
const resourceController = require("../controllers/resourceController");
const { verifyToken } = require("../middleware/authMiddleware");

// ─── Subjects ─────────────────────────────────────────────────────────────
// Lấy môn học theo ngành của user đang đăng nhập (MỚI)
router.get("/my-subjects", verifyToken, resourceController.getMySubjects);

// Tìm kiếm toàn cục qua môn học + thư mục + tài liệu (MỚI)
router.get("/search", verifyToken, resourceController.globalSearch);

// Lấy môn học theo kỳ (giữ lại để tương thích)
router.get(
  "/subjects/:semester",
  verifyToken,
  resourceController.getSubjectsBySemester,
);

// ─── Folders ──────────────────────────────────────────────────────────────
router.get("/folders/:subjectCode", verifyToken, resourceController.getFolders);
router.post("/folders", verifyToken, resourceController.createFolder);
router.delete("/folders/:id", verifyToken, resourceController.deleteFolder);

// ─── Files ────────────────────────────────────────────────────────────────
router.get("/files/:folderId", verifyToken, resourceController.getFiles);
router.post("/files", verifyToken, resourceController.createFile);
router.delete("/files/:id", verifyToken, resourceController.deleteFile);
router.delete("/:id", resourceController.deleteFolder);
module.exports = router;
