const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { pool } = require("../config/db");
const { sendOtpEmail } = require("../utils/emailService");
const otpStore = new Map();

setInterval(
  () => {
    const now = Date.now();
    for (const [email, record] of otpStore.entries()) {
      const maxExpiry = Math.max(
        record.expiresAt || 0,
        record.resetTokenExpiresAt || 0,
      );
      if (now > maxExpiry + 60_000) {
        otpStore.delete(email);
      }
    }
  },
  5 * 60 * 1000,
); // Mỗi 5 phút

const OTP_EXPIRE_MS = 5 * 60 * 1000; // 5 phút
const RESET_TOKEN_EXPIRE = 10 * 60 * 1000; // 10 phút để dùng resetToken
const MAX_OTP_ATTEMPTS = 5; // Tối đa 5 lần nhập sai
const MAX_SEND_PER_WINDOW = 3; // Tối đa 3 lần gửi OTP trong 5 phút
const RESEND_COOLDOWN_MS = 60 * 1000; // Cooldown 60s giữa các lần gửi

function generateOtp() {
  // Dùng crypto để đảm bảo randomness bảo mật
  return String(Math.floor(100000 + crypto.randomInt(900000)));
}
// [POST] /api/auth/forgot-password  — Bước 1: Gửi OTP

exports.sendOtp = async (req, res) => {
  try {
    // 1. Hứng thêm captchaToken từ req.body
    const { email, captchaToken } = req.body;

    // Validate format email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res
        .status(400)
        .json({ success: false, message: "Định dạng email không hợp lệ." });
    }

    // ── Xác thực reCAPTCHA (Chặn bot ngay từ vòng gửi xe) ──────
    if (!captchaToken) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng xác nhận bạn không phải là robot!",
      });
    }

    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${captchaToken}`;

    const recaptchaResponse = await fetch(verifyUrl, { method: "POST" });
    const recaptchaData = await recaptchaResponse.json();

    if (!recaptchaData.success) {
      return res.status(403).json({
        success: false,
        message: "Xác thực reCAPTCHA không hợp lệ hoặc đã hết hạn!",
      });
    }
    // ───────────────────────────────────────────────────────────

    const normalizedEmail = email.trim().toLowerCase();
    const now = Date.now();
    const existing = otpStore.get(normalizedEmail);

    // ── Rate limiting ──────────────────────────────────────────
    if (existing) {
      // Kiểm tra cooldown giữa 2 lần gửi
      if (existing.cooldownUntil && now < existing.cooldownUntil) {
        const wait = Math.ceil((existing.cooldownUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: `Vui lòng chờ ${wait} giây trước khi gửi lại OTP.`,
          waitSeconds: wait,
        });
      }

      // Kiểm tra số lần gửi trong cùng window 5 phút
      const withinWindow =
        existing.windowStart && now < existing.windowStart + OTP_EXPIRE_MS;
      if (withinWindow && existing.sendCount >= MAX_SEND_PER_WINDOW) {
        const waitMs = existing.windowStart + OTP_EXPIRE_MS - now;
        const waitMin = Math.ceil(waitMs / 60000);
        return res.status(429).json({
          success: false,
          message: `Bạn đã gửi OTP quá ${MAX_SEND_PER_WINDOW} lần. Vui lòng thử lại sau ~${waitMin} phút.`,
        });
      }
    }

    // ── Kiểm tra email trong DB ────────────────────────────────
    // Dùng message chung để tránh lộ thông tin (email enumeration)
    const result = await pool.query(
      'SELECT "Id", "Name" FROM "Users" WHERE "Email" = $1',
      [normalizedEmail],
    );
    const user = result.rows[0];

    // QUAN TRỌNG: Trả về thành công dù email không tồn tại
    // để tránh attacker biết email nào tồn tại trong hệ thống
    if (!user) {
      return res.status(200).json({
        success: true,
        message:
          "Nếu email tồn tại trong hệ thống, mã OTP sẽ được gửi đến hộp thư của bạn.",
        expiresInSeconds: OTP_EXPIRE_MS / 1000,
      });
    }

    // ── Sinh OTP & lưu vào store ───────────────────────────────
    const otp = generateOtp();
    const withinWindow =
      existing?.windowStart && now < existing.windowStart + OTP_EXPIRE_MS;
    const sendCount = withinWindow ? (existing.sendCount || 0) + 1 : 1;
    const windowStart = withinWindow ? existing.windowStart : now;

    otpStore.set(normalizedEmail, {
      otp,
      expiresAt: now + OTP_EXPIRE_MS,
      attempts: 0,
      sendCount,
      windowStart,
      cooldownUntil: now + RESEND_COOLDOWN_MS,
      resetToken: null,
      resetTokenExpiresAt: null,
      userId: user.Id,
      userName: user.Name,
    });

    // ── Gửi email ──────────────────────────────────────────────
    await sendOtpEmail({ email: normalizedEmail, otp, userName: user.Name });

    return res.status(200).json({
      success: true,
      message:
        "Nếu email tồn tại trong hệ thống, mã OTP sẽ được gửi đến hộp thư của bạn.",
      expiresInSeconds: OTP_EXPIRE_MS / 1000,
    });
  } catch (err) {
    console.error("[ForgotPassword][sendOtp]", err.message);
    res.status(500).json({ success: false, message: "Lỗi máy chủ nội bộ." });
  }
};

// ═══════════════════════════════════════════════════════════════
// [POST] /api/auth/verify-otp  — Bước 2: Xác thực OTP
// Body: { email, otp }
// ═══════════════════════════════════════════════════════════════
exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const normalizedEmail = (email || "").trim().toLowerCase();
    const record = otpStore.get(normalizedEmail);
    const now = Date.now();

    // OTP không tồn tại hoặc đã hết hạn
    if (!record || now > record.expiresAt) {
      otpStore.delete(normalizedEmail);
      return res.status(400).json({
        success: false,
        message:
          "Mã OTP đã hết hạn hoặc không tồn tại. Vui lòng kiểm tra lại email và tạo yêu cầu mã mới.",
        expired: true,
      });
    }

    // OTP đã bị vô hiệu hóa sau khi verify thành công
    if (record.otp === null && record.resetToken) {
      return res.status(400).json({
        success: false,
        message: "OTP này đã được sử dụng. Vui lòng tiếp tục đặt lại mật khẩu.",
      });
    }

    // Vượt quá số lần thử
    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      otpStore.delete(normalizedEmail);
      return res.status(400).json({
        success: false,
        message: `Bạn đã nhập sai OTP quá ${MAX_OTP_ATTEMPTS} lần. Vui lòng bắt đầu lại từ đầu.`,
        tooManyAttempts: true,
      });
    }

    // Sai OTP
    if (record.otp !== String(otp).trim()) {
      record.attempts += 1;
      const remaining = MAX_OTP_ATTEMPTS - record.attempts;

      if (remaining <= 0) {
        otpStore.delete(normalizedEmail);
        return res.status(400).json({
          success: false,
          message: `OTP không chính xác. Bạn đã hết lượt thử. Vui lòng bắt đầu lại.`,
          tooManyAttempts: true,
        });
      }

      return res.status(400).json({
        success: false,
        message: `OTP không chính xác. Còn ${remaining} lần thử.`,
        remainingAttempts: remaining,
      });
    }

    // ── OTP đúng → cấp resetToken ──────────────────────────────
    const resetToken = crypto.randomBytes(32).toString("hex");
    record.resetToken = resetToken;
    record.resetTokenExpiresAt = now + RESET_TOKEN_EXPIRE;
    record.otp = null; // Vô hiệu hóa OTP — chỉ dùng 1 lần

    return res.status(200).json({
      success: true,
      message: "Xác thực OTP thành công.",
      resetToken,
    });
  } catch (err) {
    console.error("[ForgotPassword][verifyOtp]", err.message);
    res.status(500).json({ success: false, message: "Lỗi máy chủ nội bộ." });
  }
};

// ═══════════════════════════════════════════════════════════════
// [POST] /api/auth/reset-password  — Bước 3: Đặt lại mật khẩu
// Body: { email, resetToken, newPassword }
// ═══════════════════════════════════════════════════════════════
exports.resetPassword = async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body;
    const normalizedEmail = (email || "").trim().toLowerCase();
    const record = otpStore.get(normalizedEmail);
    const now = Date.now();

    // Validate resetToken
    if (
      !record ||
      !record.resetToken ||
      record.resetToken !== resetToken ||
      now > record.resetTokenExpiresAt
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Phiên đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Vui lòng thử lại từ đầu.",
      });
    }

    // Validate mật khẩu mới
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Mật khẩu phải có ít nhất 8 ký tự.",
      });
    }

    // Hash & cập nhật DB
    const hash = await bcrypt.hash(newPassword, 10);
    const updateResult = await pool.query(
      `
      UPDATE "Users" 
      SET "PasswordHash" = $1, 
          "LastPasswordChange" = NOW() 
      WHERE "Email" = $2
    `,
      [hash, normalizedEmail],
    );

    if (updateResult.rowCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Tài khoản không tồn tại." });
    }

    // Xóa record OTP — đảm bảo token chỉ dùng 1 lần
    otpStore.delete(normalizedEmail);

    return res.status(200).json({
      success: true,
      message:
        "Đặt lại mật khẩu thành công! Vui lòng đăng nhập bằng mật khẩu mới.",
    });
  } catch (err) {
    console.error("[ForgotPassword][resetPassword]", err.message);
    res.status(500).json({ success: false, message: "Lỗi máy chủ nội bộ." });
  }
};
