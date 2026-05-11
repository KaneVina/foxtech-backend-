const express = require("express");
const router = express.Router();
const taskController = require("../controllers/taskController");
const { verifyToken } = require("../middleware/authMiddleware");

router.get("/my-tasks", verifyToken, taskController.getMyAllTasks);
router.get("/group/:groupId", verifyToken, taskController.getGroupTasks);
router.post("/group/:groupId", verifyToken, taskController.createTask);
router.put("/:taskId", verifyToken, taskController.updateTask);
router.get("/:taskId", verifyToken, taskController.getTaskDetail);
router.post("/assign", verifyToken, taskController.assignTask);
router.put("/:taskId/view", verifyToken, taskController.markViewed);
router.put("/:taskId/complete", verifyToken, taskController.markCompleted);
router.put("/:taskId/pin", verifyToken, taskController.togglePinTask);
router.post("/:taskId/vote", verifyToken, taskController.votePoll);
router.post("/:taskId/options", verifyToken, taskController.addPollOption);
router.put("/:taskId/close-poll", verifyToken, taskController.closePoll);
// [NEW] Nhắc nhở nhiệm vụ — chỉ leader/action leader
router.post("/:taskId/remind", verifyToken, taskController.remindTask);
// [NEW] Cập nhật link báo cáo điểm danh (Hội họp)
router.put("/:taskId/attendance-report", verifyToken, taskController.updateAttendanceReport);
module.exports = router;