const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const { verifyToken } = require("../middleware/authMiddleware");

// Các API quản lý hồ sơ cá nhân
router.get("/profile", verifyToken, userController.getProfile);
router.put("/profile", verifyToken, userController.updateProfile);
router.put("/change-password", verifyToken, userController.changePassword);

//Quản lý tạo nhóm
router.post("/check-emails", verifyToken, userController.checkEmails);
module.exports = router;
