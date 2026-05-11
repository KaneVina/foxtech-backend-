const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/authMiddleware");
const {
  uploadAvatar,
  uploadLogo,
  uploadThumbnail,
  uploadDocument,
  deleteCloudinaryImage,
} = require("../middleware/upload");
const { pool } = require("../config/db");

// ── Helper trả lỗi multer dễ đọc ─────────────────────────────────────────────
function handleMulterError(err, res) {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ success: false, message: "File quá lớn!" });
  }
  console.error("Upload error:", err);
  return res.status(500).json({ success: false, message: "Upload thất bại!" });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/upload/avatar
// Body: multipart/form-data  field: "avatar"
// ── [CẬP NHẬT] Thêm:
//    1. Kiểm tra giới hạn 7 ngày (AvatarLastChanged)
//    2. Xóa ảnh cũ bằng AvatarPublicId (chính xác hơn dùng URL)
//    3. Lưu AvatarPublicId + AvatarLastChanged vào DB
// ────────────────────────────────────────────────────────────────────────────
router.post("/avatar", verifyToken, (req, res) => {
  uploadAvatar.single("avatar")(req, res, async (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "Không có file!" });

    const userId = req.user.id || req.user.Id;
    const newUrl = req.file.path; // Cloudinary URL
    const newPublicId = req.file.filename; // Cloudinary public_id

    try {
      // ── 1. Lấy thông tin cũ: ảnh cũ + lần đổi cuối ──────────────────────
      const old = await pool.query(
        `SELECT "AvatarPublicId", "AvatarUrl", "AvatarLastChanged" FROM "Users" WHERE "Id" = $1`,
        [userId],
      );
      const {
        AvatarPublicId: oldPublicId,
        AvatarUrl: oldUrl,
        AvatarLastChanged: lastChanged,
      } = old.rows[0] || {};

      // ── 2. Kiểm tra giới hạn 7 ngày ──────────────────────────────────────
      if (lastChanged) {
        const diffMs = Date.now() - new Date(lastChanged).getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays < 7) {
          const daysLeft = Math.ceil(7 - diffDays);
          // Xóa ảnh vừa upload lên để tránh rác trên Cloudinary
          await deleteCloudinaryImage(newUrl).catch(() => {});
          return res.status(429).json({
            success: false,
            message: `Bạn chỉ được đổi ảnh đại diện 1 lần/7 ngày. Còn ${daysLeft} ngày nữa.`,
            daysLeft,
          });
        }
      }

      // ── 3. Xóa ảnh cũ trên Cloudinary ────────────────────────────────────
      // Ưu tiên dùng AvatarPublicId (chính xác), fallback sang AvatarUrl
      const toDelete = oldPublicId || oldUrl;
      if (toDelete) {
        await deleteCloudinaryImage(toDelete).catch((e) =>
          console.warn("[Avatar] Xóa ảnh cũ thất bại (bỏ qua):", e.message),
        );
      }

      // ── 4. Lưu vào DB: URL mới + PublicId mới + timestamp ────────────────
      const now = new Date();
      await pool.query(
        `UPDATE "Users"
         SET "AvatarUrl"         = $1,
             "AvatarPublicId"    = $2,
             "AvatarLastChanged" = $3
         WHERE "Id" = $4`,
        [newUrl, newPublicId, now, userId],
      );

      return res.json({
        success: true,
        url: newUrl,
        avatarLastChanged: now.toISOString(),
        message: "Cập nhật avatar thành công!",
      });
    } catch (dbErr) {
      console.error("Lỗi DB avatar:", dbErr);
      // Dọn ảnh vừa upload nếu DB lỗi
      await deleteCloudinaryImage(newUrl).catch(() => {});
      return res.status(500).json({ success: false, message: "Lỗi lưu DB!" });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/upload/logo/:universityId   (admin only)
// ────────────────────────────────────────────────────────────────────────────
router.post("/logo/:universityId", verifyToken, (req, res) => {
  uploadLogo.single("logo")(req, res, async (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "Không có file!" });

    const { universityId } = req.params;
    const newUrl = req.file.path;

    try {
      const old = await pool.query(
        `SELECT "LogoUrl" FROM "Universities" WHERE "Id" = $1`,
        [universityId],
      );
      if (old.rows[0]?.LogoUrl)
        await deleteCloudinaryImage(old.rows[0].LogoUrl);

      await pool.query(
        `UPDATE "Universities" SET "LogoUrl" = $1 WHERE "Id" = $2`,
        [newUrl, universityId],
      );

      res.json({
        success: true,
        url: newUrl,
        message: "Cập nhật logo thành công!",
      });
    } catch (dbErr) {
      console.error("Lỗi DB logo:", dbErr);
      res.status(500).json({ success: false, message: "Lỗi lưu DB!" });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/upload/thumbnail/:courseId
// ────────────────────────────────────────────────────────────────────────────
router.post("/thumbnail/:courseId", verifyToken, (req, res) => {
  uploadThumbnail.single("thumbnail")(req, res, async (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "Không có file!" });

    const { courseId } = req.params;
    const newUrl = req.file.path;

    try {
      const old = await pool.query(
        `SELECT "ThumbnailUrl" FROM "Courses" WHERE "Id" = $1`,
        [courseId],
      );
      if (old.rows[0]?.ThumbnailUrl)
        await deleteCloudinaryImage(old.rows[0].ThumbnailUrl);

      await pool.query(
        `UPDATE "Courses" SET "ThumbnailUrl" = $1 WHERE "Id" = $2`,
        [newUrl, courseId],
      );

      res.json({
        success: true,
        url: newUrl,
        message: "Cập nhật thumbnail thành công!",
      });
    } catch (dbErr) {
      console.error("Lỗi DB thumbnail:", dbErr);
      res.status(500).json({ success: false, message: "Lỗi lưu DB!" });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/upload/document
// ────────────────────────────────────────────────────────────────────────────
router.post("/document", verifyToken, (req, res) => {
  uploadDocument.single("file")(req, res, async (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "Không có file!" });

    res.json({
      success: true,
      url: req.file.path,
      message: "Upload tài liệu thành công!",
    });
  });
});
const uploadCtrl = require("../controllers/uploadController");

router.post("/evidence", verifyToken, uploadCtrl.uploadEvidence);

module.exports = router;
