const express = require("express");
const router = express.Router();
const notifCtrl = require("../controllers/notificationController");
const { verifyToken } = require("../middleware/authMiddleware");

// Tất cả routes đều cần đăng nhập
router.use(verifyToken);

// GET danh sách (hỗ trợ ?limit=N)
router.get("/", notifCtrl.getNotifications);

// PUT đánh dấu 1 thông báo đã đọc
router.put("/:id/read", notifCtrl.markAsRead);

// PUT đánh dấu tất cả đã đọc
router.put("/read-all", notifCtrl.markAllAsRead);

// DELETE 1 thông báo
router.delete("/:id", notifCtrl.deleteNotification);

// DELETE tất cả đã đọc
router.delete("/read-all", notifCtrl.deleteAllRead);

module.exports = router;
