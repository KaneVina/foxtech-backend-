const express = require("express");
const router = express.Router();
const requestController = require("../controllers/requestController");
const { verifyToken } = require("../middleware/authMiddleware");

// Các API xử lý đơn từ - Cần có token bảo mật
router.post("/", verifyToken, requestController.createRequest);
router.get("/manage", verifyToken, requestController.getManageRequests);
router.get("/my-requests", verifyToken, requestController.getMyRequests);
router.put("/:id/resolve", verifyToken, requestController.resolveRequest);

module.exports = router;
