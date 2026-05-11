const { pool } = require("../config/db");

async function createNotifications({
  userIds, title, message,
  type = "system", category = "system",
  groupId = null, senderId = null,
  referenceId = null, skipSelf = true,
}) {
  if (!userIds || userIds.length === 0) return;

  let senderInfo = null;
  if (senderId) {
    try {
      const sRes = await pool.query(
        `SELECT "Name", "AvatarUrl", "Role" FROM "Users" WHERE "Id" = $1`,
        [senderId]
      );
      if (sRes.rows.length > 0) {
        senderInfo = {
          SenderName: sRes.rows[0].Name,
          AvatarUrl:  sRes.rows[0].AvatarUrl,
          SenderRole: sRes.rows[0].Role,
        };
      }
    } catch (_) {}
  }

  const uniqueIds = [...new Set(userIds.map(Number).filter(Boolean))];

  for (const userId of uniqueIds) {
    if (skipSelf && senderId && userId === Number(senderId)) continue;
    try {
      const result = await pool.query(
        `INSERT INTO "Notifications"
           ("UserId","Title","Message","IsRead","Type","GroupId","SenderId","Category","ReferenceId","CreatedAt")
         VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8,NOW())
         RETURNING *`,
        [userId, title, message, type, groupId, senderId, category, referenceId]
      );
      const newNotif = result.rows[0];

      if (global.io && global.onlineUsers) {
        const socketId =
          global.onlineUsers.get(userId) ||
          global.onlineUsers.get(String(userId));
        if (socketId) {
          global.io.to(socketId).emit("receive-notification", { ...newNotif, ...senderInfo });
        }
      }
    } catch (err) {
      console.error(`[notificationHelper] Lỗi tạo notif cho userId=${userId}:`, err.message);
    }
  }
}

async function getGroupMemberIds(groupId) {
  const res = await pool.query(
    `SELECT "UserId" FROM "GroupMembers" WHERE "GroupId" = $1`,
    [groupId]
  );
  return res.rows.map((r) => r.UserId);
}

module.exports = { createNotifications, getGroupMemberIds };