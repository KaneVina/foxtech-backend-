const { pool } = require("../config/db");

// [GET] Lấy danh sách thông báo của User
exports.getNotifications = async (req, res) => {
  try {
    const userId = parseInt(req.user?.id || req.user?.Id || req.userId, 10);
    const limit = parseInt(req.query.limit) || 50; // Cho phép page truyền limit=100

    if (isNaN(userId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user ID" });
    }

    const result = await pool.query(
      `SELECT n.*, u."Name" AS "SenderName", u."AvatarUrl", u."Role" AS "SenderRole"
       FROM "Notifications" n
       LEFT JOIN "Users" u ON n."SenderId" = u."Id"
       WHERE n."UserId" = $1
       ORDER BY n."CreatedAt" DESC
       LIMIT $2`,
      [userId, limit],
    );

    // Đếm unread riêng (để badge chính xác)
    const unreadRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM "Notifications" WHERE "UserId" = $1 AND "IsRead" = false`,
      [userId],
    );

    res.status(200).json({
      success: true,
      data: result.rows,
      unreadCount: parseInt(unreadRes.rows[0].cnt),
    });
  } catch (err) {
    console.error("Lỗi getNotifications:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// [PUT] Đánh dấu 1 thông báo là đã đọc
exports.markAsRead = async (req, res) => {
  try {
    const userId = parseInt(req.user?.id || req.user?.Id || req.userId, 10);
    const notifId = parseInt(req.params.id, 10);

    if (isNaN(userId) || isNaN(notifId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid parameters" });
    }

    await pool.query(
      `UPDATE "Notifications" SET "IsRead" = true WHERE "Id" = $1 AND "UserId" = $2`,
      [notifId, userId],
    );

    res.status(200).json({ success: true, message: "Đã đánh dấu đọc" });
  } catch (err) {
    console.error("Lỗi markAsRead:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// [PUT] Đánh dấu tất cả là đã đọc
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = parseInt(req.user?.id || req.user?.Id || req.userId, 10);

    if (isNaN(userId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user ID" });
    }

    await pool.query(
      `UPDATE "Notifications" SET "IsRead" = true WHERE "UserId" = $1 AND "IsRead" = false`,
      [userId],
    );

    res.status(200).json({ success: true, message: "Đã đánh dấu đọc tất cả" });
  } catch (err) {
    console.error("Lỗi markAllAsRead:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// [DELETE] Xóa một thông báo
exports.deleteNotification = async (req, res) => {
  try {
    const userId = parseInt(req.user?.id || req.user?.Id || req.userId, 10);
    const notifId = parseInt(req.params.id, 10);

    await pool.query(
      `DELETE FROM "Notifications" WHERE "Id" = $1 AND "UserId" = $2`,
      [notifId, userId],
    );

    res.status(200).json({ success: true, message: "Đã xóa thông báo" });
  } catch (err) {
    console.error("Lỗi deleteNotification:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// [DELETE] Xóa tất cả thông báo đã đọc
exports.deleteAllRead = async (req, res) => {
  try {
    const userId = parseInt(req.user?.id || req.user?.Id || req.userId, 10);

    await pool.query(
      `DELETE FROM "Notifications" WHERE "UserId" = $1 AND "IsRead" = true`,
      [userId]
    );

    res
      .status(200)
      .json({ success: true, message: "Đã xóa tất cả thông báo đã đọc" });
  } catch (err) {
    console.error("Lỗi deleteAllRead:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
