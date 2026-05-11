// backend/routes/groupRoutes.js
const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { verifyToken } = require("../middleware/authMiddleware");
const checkRole = require("../middleware/roleMiddleware");
const groupController = require("../controllers/groupController");

const guard = [verifyToken, checkRole(["admin"])];

// ==========================================
// [MIDDLEWARE] Kiểm tra quyền Leader
// ==========================================
async function requireGroupLeader(req, res, next) {
  const groupId = req.params.id || req.params.groupId;
  const userId = req.user.id || req.user.Id || req.userId;
  try {
    const check = await pool.query(
      `SELECT "GroupRole" FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [groupId, userId],
    );
    if (!check.rows[0] || check.rows[0].GroupRole !== "Leader") {
      return res.status(403).json({
        success: false,
        message: "Chỉ Leader mới có quyền thực hiện hành động này!",
      });
    }
    next();
  } catch (err) {
    console.error("Lỗi kiểm tra quyền Leader:", err);
    return res
      .status(500)
      .json({ success: false, message: "Lỗi Server khi kiểm tra quyền!" });
  }
}

// ==========================================
// [MIDDLEWARE] Kiểm tra quyền Leader HOẶC Action Leader
// ==========================================
async function requireLeaderOrAL(req, res, next) {
  const groupId = req.params.id || req.params.groupId;
  const userId = req.user.id || req.user.Id || req.userId;
  try {
    const check = await pool.query(
      `SELECT "GroupRole" FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [groupId, userId],
    );
    const role = check.rows[0]?.GroupRole?.toLowerCase() || "";
    const sysRole = (req.user.role || req.user.Role || "").toLowerCase();
    if (role !== "leader" && role !== "action leader" && sysRole !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Cần quyền Leader hoặc Action Leader!",
      });
    }
    next();
  } catch (err) {
    console.error("Lỗi kiểm tra quyền Leader/AL:", err);
    return res
      .status(500)
      .json({ success: false, message: "Lỗi Server khi kiểm tra quyền!" });
  }
}

// ============================================================
// STATIC ROUTES — không có params động, phải đứng đầu
// ============================================================

// Lấy danh sách môn học
router.get("/subjects", verifyToken, groupController.getSubjects);

// Tìm kiếm giảng viên
router.get("/lecturers/search", verifyToken, groupController.searchLecturers);

// Lấy tất cả nhóm (Admin)
router.get("/all", guard, groupController.getAllGroups);

// Lấy danh sách nhóm của user đang đăng nhập
router.get("/", verifyToken, groupController.getMyGroups);

// Tạo nhóm mới / gửi đơn
router.post("/", verifyToken, groupController.createGroup);

// Thêm thành viên — route cũ giữ lại để tương thích (nếu không cần thì xóa)
router.post(
  "/add-member",
  verifyToken,
  requireLeaderOrAL,
  groupController.addMember,
);

// ============================================================
// NESTED ROUTES — /:groupId/... phải đứng TRƯỚC /:id
// ============================================================

// Thống kê tổng quan cho Leader
router.get(
  "/:groupId/leader-stats",
  verifyToken,
  groupController.getLeaderStats,
);

// Tài liệu nhóm
router.get(
  "/:groupId/resources",
  verifyToken,
  groupController.getGroupResources,
);

// Cập nhật link liên kết nhóm (Leader / AL)
router.put(
  "/:groupId/links",
  verifyToken,
  requireLeaderOrAL,
  groupController.updateGroupLinks,
);

// Gửi thông báo tức thì (Leader / AL)
router.post(
  "/:groupId/notify",
  verifyToken,
  requireLeaderOrAL,
  groupController.sendInstantNotification,
);

// Lấy danh sách thành viên
router.get("/:groupId/members", verifyToken, groupController.getMembers);

// Thêm thành viên — RESTful route mới (GroupMembers.jsx dùng cái này)
router.post(
  "/:groupId/members",
  verifyToken,
  requireLeaderOrAL,
  groupController.addMember,
);

// Lấy nhiệm vụ của 1 thành viên trong nhóm
router.get(
  "/:groupId/members/:userId/tasks",
  verifyToken,
  groupController.getMemberTasksInGroup,
);

// Đổi vai trò thành viên (chỉ Leader)
router.put(
  "/:groupId/members/:userId/role",
  verifyToken,
  requireGroupLeader,
  groupController.updateMemberRole,
);

// ⚠️ /me phải đứng TRƯỚC /:userId để không bị match nhầm
router.delete("/:groupId/members/me", verifyToken, groupController.leaveGroup);

// Xóa thành viên khỏi nhóm (chỉ Leader)
router.delete(
  "/:groupId/members/:userId",
  verifyToken,
  requireGroupLeader,
  groupController.removeMember,
);

// ============================================================
// /:id ROUTES — phải đứng CUỐI CÙNG vì là wildcard
// ============================================================

// Lấy chi tiết nhóm
router.get("/:id", verifyToken, groupController.getGroupById);

// Cập nhật mô tả nhóm + giảng viên (chỉ Leader)
router.put(
  "/:id/description",
  verifyToken,
  requireGroupLeader,
  groupController.updateGroupDescription,
);

// Duyệt đơn xin tạo nhóm (Admin)
router.post("/:requestId/approve", guard, groupController.approveGroupRequest);

module.exports = router;
