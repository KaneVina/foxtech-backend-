const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");

// [POST] Tạo tài khoản (chỉ admin/leader/action leader)
exports.register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const creatorRole = req.user.role;

    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ success: false, message: "Mật khẩu tối thiểu 8 ký tự." });
    }

    if (
      (creatorRole === "leader" || creatorRole === "action leader") &&
      role !== "user"
    ) {
      return res.status(403).json({
        success: false,
        message: "Quyền hạn không đủ: Bạn chỉ được tạo tài khoản user.",
      });
    }

    const existing = await pool.query(
      'SELECT "Id" FROM "Users" WHERE "Email" = $1',
      [email],
    );
    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ success: false, message: "Email này đã được sử dụng!" });
    }

    const hash = await bcrypt.hash(password, 10);

    // ── Tự động sinh mã FID ───────────────────────────────────
    const now = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const yy = String(now.getUTCFullYear()).slice(-2);
    const datePrefix = `FT4${mm}${dd}${yy}`;

    const lastUserQuery = await pool.query(
      `SELECT "Fid" FROM "Users" WHERE "Fid" LIKE $1 ORDER BY "Fid" DESC LIMIT 1`,
      [datePrefix + "%"],
    );

    let sequence = 1;
    if (lastUserQuery.rows.length > 0 && lastUserQuery.rows[0].Fid) {
      const lastSequence = parseInt(lastUserQuery.rows[0].Fid.slice(-3), 10);
      if (!isNaN(lastSequence)) sequence = lastSequence + 1;
    }

    const newFid = `${datePrefix}${String(sequence).padStart(3, "0")}`;
    // ─────────────────────────────────────────────────────────

    await pool.query(
      `INSERT INTO "Users"("Name", "Email", "PasswordHash", "Role", "Fid") VALUES($1, $2, $3, $4, $5)`,
      [name, email, hash, role, newFid],
    );

    res.status(201).json({
      success: true,
      message: "Tạo tài khoản thành công!",
      fid: newFid,
    });
  } catch (err) {
    console.error("Lỗi khi tạo tài khoản:", err);
    res.status(500).json({ success: false, message: "Lỗi máy chủ nội bộ." });
  }
};

// [POST] Đăng nhập bằng email/password
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập đầy đủ email và mật khẩu!",
      });
    }

    const result = await pool.query(
      `
      SELECT
        u.*,
        uni."Name" AS "UniversityName",
        uni."LogoUrl" AS "UniversityLogoUrl",
        m."Name" AS "MajorName",
        m."MajorCode"
      FROM "Users" u
      LEFT JOIN "Universities" uni ON u."UniversityId" = uni."Id"
      LEFT JOIN "Majors" m ON u."MajorId" = m."Id"
      WHERE u."Email" = $1
      `,
      [email],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Email không tồn tại trong hệ thống!",
      });
    }

    const user = result.rows[0];

    if (user.Status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Tài khoản của bạn đã bị khóa. Vui lòng liên hệ admin!",
      });
    }

    const valid = await bcrypt.compare(password, user.PasswordHash);
    if (!valid) {
      return res
        .status(400)
        .json({ success: false, message: "Mật khẩu không chính xác!" });
    }

    // FIX: Bỏ fallback "SECRET_KEY" — bắt buộc phải có JWT_SECRET trong .env
    if (!process.env.JWT_SECRET) {
      console.error("❌ JWT_SECRET chưa được cấu hình trong .env!");
      return res
        .status(500)
        .json({ success: false, message: "Lỗi cấu hình server." });
    }

    const token = jwt.sign(
      {
        id: user.Id,
        role: (user.Role || "user").toLowerCase(),
        name: user.Name,
        universityId: user.UniversityId || null,
        majorId: user.MajorId || null,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
    );

    res.json({
      success: true,
      token,
      id: user.Id,
      role: user.Role,
      name: user.Name,
      avatarUrl: user.AvatarUrl,
      universityId: user.UniversityId || null,
      universityName: user.UniversityName || null,
      universityLogoUrl: user.UniversityLogoUrl || null,
      majorId: user.MajorId || null,
      majorName: user.MajorName || null,
      majorCode: user.MajorCode || null,
    });
  } catch (err) {
    console.error("Lỗi login:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server khi đăng nhập!" });
  }
};
