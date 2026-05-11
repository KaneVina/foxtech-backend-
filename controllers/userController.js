const { pool } = require("../config/db");
const bcrypt = require("bcrypt");

// [GET] Lấy thông tin hồ sơ của user
exports.getProfile = async (req, res) => {
  try {
    const userId = parseInt(req.user.id || req.user.Id || req.userId);
    const result = await pool.query(`
      SELECT 
        u."Id", u."Name", u."Email", u."Role", u."AvatarUrl", u."StudentId", 
        u."Phone", u."DOB", u."Status", u."CreatedAt", u."Gender", u."CurrentTerm", 
        u."MemberCode", 
        u."Fid",              
        u."LastPasswordChange", 
        u."MajorId", m."Name" as "MajorName", 
        u."UniversityId", uni."Name" as "UniversityName", uni."LogoUrl" as "UniversityLogo", uni."WebsiteLink"
      FROM "Users" u
      LEFT JOIN "Majors" m ON u."MajorId" = m."Id"
      LEFT JOIN "Universities" uni ON u."UniversityId" = uni."Id"
      WHERE u."Id" = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy tài khoản!" });
    }

    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("Lỗi lấy profile:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi server khi lấy hồ sơ! Vui lòng liên hệ admin.",
    });
  }
};

// [PUT] Cập nhật thông tin cơ bản
exports.updateProfile = async (req, res) => {
  try {
    const userId = parseInt(req.user.id || req.user.Id || req.userId);
    const {
      name,
      avatarUrl,
      studentId,
      phone,
      dob,
      gender,
      currentTerm,
      memberCode, // <-- [THÊM MỚI] Nhận memberCode từ Frontend gửi lên
    } = req.body;

    if (!name || name.trim() === "") {
      return res
        .status(400)
        .json({ success: false, message: "Tên không được để trống!" });
    }

    const safeStudentId =
      studentId && studentId.trim() !== "" ? studentId : null;
    const safePhone = phone && phone.trim() !== "" ? phone : null;
    const safeDOB = dob && dob.trim() !== "" ? dob : null;
    const safeGender = gender && gender.trim() !== "" ? gender : null;

    // <-- [THÊM MỚI] Đảm bảo an toàn dữ liệu, nếu rỗng thì lưu là NULL
    const safeMemberCode =
      memberCode && memberCode.trim() !== "" ? memberCode : null;

    // <-- [THÊM MỚI] Bổ sung MemberCode = $8 vào câu lệnh UPDATE
    await pool.query(`
      UPDATE "Users" 
      SET 
        "Name" = $1, 
        "AvatarUrl" = $2,
        "StudentId" = $3,
        "Phone" = $4,
        "DOB" = $5,
        "Gender" = $6,
        "CurrentTerm" = $7,
        "MemberCode" = $8 
      WHERE "Id" = $9
    `, [
      name, 
      avatarUrl || null, 
      safeStudentId, 
      safePhone, 
      safeDOB, 
      safeGender, 
      currentTerm || null, 
      safeMemberCode, 
      userId
    ]);

    res
      .status(200)
      .json({ success: true, message: "Cập nhật hồ sơ thành công!" });
  } catch (err) {
    console.error("Lỗi cập nhật profile:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi server khi cập nhật hồ sơ! Vui lòng liên hệ admin.",
    });
  }
};

// [PUT] Đổi mật khẩu
exports.changePassword = async (req, res) => {
  try {
    const userId = parseInt(req.user.id || req.user.Id || req.userId);
    const { currentPassword, newPassword } = req.body;

    // 1. Lấy thông tin user hiện tại để lấy PasswordHash
    const userRes = await pool.query(`SELECT "PasswordHash" FROM "Users" WHERE "Id" = $1`, [userId]);
    
    if (userRes.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy tài khoản!" });
    }

    const user = userRes.rows[0];

    // 2. Kiểm tra mật khẩu cũ có khớp không
    const isMatch = await bcrypt.compare(currentPassword, user.PasswordHash);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Mật khẩu hiện tại không chính xác!",
      });
    }

    // 3. Mã hóa mật khẩu mới và lưu vào DB
    const salt = await bcrypt.genSalt(10);
    const hashedNewPassword = await bcrypt.hash(newPassword, salt);

    await pool.query(`
      UPDATE "Users" 
      SET "PasswordHash" = $1 
      WHERE "Id" = $2
    `, [hashedNewPassword, userId]);

    res
      .status(200)
      .json({ success: true, message: "Đổi mật khẩu thành công!" });
  } catch (err) {
    console.error("Lỗi đổi mật khẩu:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi server khi đổi mật khẩu! Vui lòng liên hệ admin.",
    });
  }
};

// ==========================================
// [POST] Kiểm tra danh sách Email (Dùng cho tạo nhóm)
// ==========================================
exports.checkEmails = async (req, res) => {
  try {
    const { emails } = req.body;
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Danh sách email trống" });
    }

    const validEmails = emails.map((e) => e?.trim()).filter((e) => e);
    if (validEmails.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Danh sách email không hợp lệ" });
    }

    // Sử dụng ANY($1::text[]) thay cho chuỗi vòng lặp của mssql - Cực kỳ an toàn và tối ưu cho PostgreSQL
    const result = await pool.query(`
      SELECT "Id", "Name", "Email", "StudentId", "Role", "Status" 
      FROM "Users" 
      WHERE "Email" = ANY($1::text[])
    `, [validEmails]);

    // Phân loại: Danh sách đã tồn tại trong DB
    const existingUsers = result.rows.map((u) => ({
      ...u,
      isExisting: true,
    }));

    const existingEmails = existingUsers.map((u) => u.Email.toLowerCase());

    // Phân loại: Danh sách chưa tồn tại
    const newUsers = validEmails
      .filter((email) => !existingEmails.includes(email.toLowerCase()))
      .map((email) => ({
        Email: email,
        Name: "",
        StudentId: "",
        Role: "user",
        isExisting: false,
      }));

    res.status(200).json({
      success: true,
      data: {
        existingUsers,
        newUsers,
      },
    });
  } catch (err) {
    console.error("Lỗi checkEmails:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server khi kiểm tra email!" });
  }
};