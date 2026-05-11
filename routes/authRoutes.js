const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const forgotPasswordController = require("../controllers/forgotPasswordController");
const { verifyToken } = require("../middleware/authMiddleware");
const checkRole = require("../middleware/roleMiddleware");

// ── Public Routes ──────────────────────────────────────────────

// Đăng nhập
router.post("/login", authController.login);

// Forgot Password — 3 bước
router.post("/forgot-password", forgotPasswordController.sendOtp); // Bước 1: Gửi OTP
router.post("/verify-otp", forgotPasswordController.verifyOtp); // Bước 2: Xác thực OTP
router.post("/reset-password", forgotPasswordController.resetPassword); // Bước 3: Đặt lại mật khẩu

// ── Protected Routes ───────────────────────────────────────────

// Tạo tài khoản (chỉ admin / leader / action leader)
router.post(
  "/create-user",
  verifyToken,
  checkRole(["admin", "leader", "action leader"]),
  authController.register,
);

module.exports = router;
