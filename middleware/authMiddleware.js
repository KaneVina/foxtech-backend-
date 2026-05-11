const jwt = require("jsonwebtoken");

function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "Yêu cầu cung cấp Token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // Tự động gia hạn token nếu còn dưới 2 giờ
    const now = Math.floor(Date.now() / 1000);
    const timeLeft = decoded.exp - now;
    if (timeLeft < 2 * 60 * 60) {
      const newToken = jwt.sign(
        {
          id: decoded.id,
          role: decoded.role,
          name: decoded.name,
          universityId: decoded.universityId,
          majorId: decoded.majorId,
        },
        process.env.JWT_SECRET,
        { expiresIn: "1d" },
      );
      // Gửi token mới về qua header để frontend cập nhật
      res.setHeader("x-new-token", newToken);
    }

    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        code: "TOKEN_EXPIRED",
        message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
      });
    }
    return res.status(401).json({
      success: false,
      code: "TOKEN_INVALID",
      message: "Token không hợp lệ.",
    });
  }
}

module.exports = { verifyToken };
