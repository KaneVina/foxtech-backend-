const { pool } = require("../config/db");
const bcrypt = require("bcrypt");
const { createNotifications } = require("../utils/notificationHelper");
const emailService = require("../utils/emailService");

async function generateFid() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const prefix = `FT4${mm}${dd}${yy}`; // VD: FT4042926

  const res = await pool.query(
    `SELECT COUNT(*) as cnt FROM "Users" WHERE "Fid" LIKE $1`,
    [`${prefix}%`],
  );
  const seq = parseInt(res.rows[0].cnt) + 1;
  return `${prefix}${String(seq).padStart(3, "0")}`; // VD: FT4042926001
}

// 1. Lấy thống kê (Dashboard)
exports.getStats = async (req, res) => {
  try {
    const [
      usersTotal,
      roleStats,
      statusStats,
      groupsTotal,
      tasksTotal,
      requestStats,
      recentUsers,
      groupActivity,
      subjectGroupStats,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM "Users"'),
      pool.query('SELECT "Role", COUNT(*) as cnt FROM "Users" GROUP BY "Role"'),
      pool.query(
        `SELECT COALESCE("Status",'active') as "Status", COUNT(*) as cnt FROM "Users" GROUP BY "Status"`,
      ),
      pool.query('SELECT COUNT(*) as total FROM "Groups"'),
      pool.query('SELECT COUNT(*) as total FROM "Tasks"'),
      pool.query(
        `SELECT COALESCE("Status",'Pending') as "Status", COUNT(*) as cnt FROM "Requests" GROUP BY "Status"`,
      ),
      pool.query(`
        SELECT TO_CHAR("CreatedAt", 'YYYY-MM-DD') as date, COUNT(*) as cnt
        FROM "Users"
        GROUP BY TO_CHAR("CreatedAt", 'YYYY-MM-DD')
        ORDER BY date DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT
          g."Id", g."Name", g."ClassName", g."Semester",
          COUNT(DISTINCT gm."UserId") as "memberCount",
          COUNT(DISTINCT t."Id") as "taskCount",
          MAX(t."CreatedAt") as "lastActivity",
          COALESCE(MAX(g."IsActive"::int), 1) as "IsActive"
        FROM "Groups" g
        LEFT JOIN "GroupMembers" gm ON gm."GroupId" = g."Id"
        LEFT JOIN "Tasks" t ON t."GroupId" = g."Id"
        GROUP BY g."Id", g."Name", g."ClassName", g."Semester"
        ORDER BY g."Id" DESC
      `),
      pool.query(`
        SELECT s."SubjectCode", s."SubjectName", COUNT(g."Id") as "groupCount"
        FROM "Subjects" s
        LEFT JOIN "Groups" g ON g."SubjectCode" = s."SubjectCode"
        GROUP BY s."SubjectCode", s."SubjectName"
        ORDER BY "groupCount" DESC
      `),
    ]);

    res.json({
      success: true,
      data: {
        totalUsers: usersTotal.rows[0].total,
        totalGroups: groupsTotal.rows[0].total,
        totalTasks: tasksTotal.rows[0].total,
        roleStats: roleStats.rows,
        statusStats: statusStats.rows,
        requestStats: requestStats.rows,
        recentUsers: recentUsers.rows.reverse(),
        groupActivity: groupActivity.rows,
        subjectGroupStats: subjectGroupStats.rows,
      },
    });
  } catch (err) {
    console.error("getStats:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ============================================================
// USERS
// ============================================================
exports.getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || "";
    const role = req.query.role || "";
    const status = req.query.status || "";
    // Sort support
    const sortBy = req.query.sortBy || "CreatedAt";
    const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
    const allowedSort = [
      "Name",
      "Email",
      "Role",
      "Status",
      "CreatedAt",
      "StudentId",
    ];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : "CreatedAt";

    const offset = (page - 1) * limit;
    const searchParam = `%${search}%`;

    const countResult = await pool.query(
      `
      SELECT COUNT(*) as total 
      FROM "Users" u
      WHERE (u."Name" ILIKE $1 
         OR u."Email" ILIKE $1 
         OR u."Fid" ILIKE $1 
         OR u."StudentId" ILIKE $1)
      AND ($2 = '' OR u."Role" = $2)
      AND ($3 = '' OR COALESCE(u."Status", 'active') = $3)
    `,
      [searchParam, role, status],
    );

    const total = countResult.rows[0].total;

    const usersResult = await pool.query(
      `
      SELECT u.*, un."Name" as "UniversityName", m."Name" as "MajorName"
      FROM "Users" u
      LEFT JOIN "Universities" un ON u."UniversityId" = un."Id"
      LEFT JOIN "Majors" m ON u."MajorId" = m."Id"
      WHERE (u."Name" ILIKE $1 
         OR u."Email" ILIKE $1 
         OR u."Fid" ILIKE $1 
         OR u."StudentId" ILIKE $1)
      AND ($2 = '' OR u."Role" = $2)
      AND ($3 = '' OR COALESCE(u."Status", 'active') = $3)
      ORDER BY u."${safeSortBy}" ${sortDir}
      OFFSET $4 LIMIT $5
    `,
      [searchParam, role, status, offset, limit],
    );

    res.json({
      success: true,
      data: usersResult.rows,
      total: parseInt(total),
      page,
      limit,
    });
  } catch (error) {
    console.error("Lỗi lấy danh sách User:", error);
    res
      .status(500)
      .json({ success: false, message: "Lỗi hệ thống khi tải User!" });
  }
};

exports.createUser = async (req, res) => {
  try {
    const name = req.body.name || req.body.Name;
    const email = req.body.email || req.body.Email;
    const password = req.body.password || req.body.Password;
    const role = req.body.role || req.body.Role;
    const studentId = req.body.studentId || req.body.StudentId;
    const majorId = req.body.majorId || req.body.MajorId;
    const universityId = req.body.universityId || req.body.UniversityId;
    const currentTerm = req.body.currentTerm || req.body.CurrentTerm;

    if (!name || !email || !password)
      return res.status(400).json({
        success: false,
        message: "Vui lòng điền đầy đủ thông tin bắt buộc!",
      });

    if (password.length < 8)
      return res
        .status(400)
        .json({ success: false, message: "Mật khẩu tối thiểu 8 ký tự!" });

    const existing = await pool.query(
      `SELECT "Id" FROM "Users" WHERE "Email" = $1`,
      [email],
    );
    if (existing.rows.length > 0)
      return res
        .status(409)
        .json({ success: false, message: "Email này đã được sử dụng!" });

    // ✅ Tự sinh FID
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const yy = String(now.getFullYear()).slice(-2);
    const prefix = `FT4${mm}${dd}${yy}`;
    const fidRes = await pool.query(
      `SELECT COUNT(*) as cnt FROM "Users" WHERE "Fid" LIKE $1`,
      [`${prefix}%`],
    );
    const seq = parseInt(fidRes.rows[0].cnt) + 1;
    const fid = `${prefix}${String(seq).padStart(3, "0")}`;

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `INSERT INTO "Users"("Name","Email","PasswordHash","Role","StudentId","Status","MajorId","UniversityId","CurrentTerm","Fid")
       VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9)`,
      [
        name,
        email,
        hash,
        role || "user",
        studentId || null,
        majorId ? parseInt(majorId) : null,
        universityId ? parseInt(universityId) : null,
        currentTerm || null,
        fid,
      ],
    );

    // ✅ Gửi email thông báo (không block response)
    emailService
      .sendNewAccountEmail({
        email,
        name,
        password,
        loginUrl: process.env.FRONTEND_URL,
      })
      .catch(() => {});

    return res
      .status(201)
      .json({ success: true, message: "Tạo tài khoản thành công!" });
  } catch (err) {
    console.error("createUser:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      Name,
      Email,
      Role,
      StudentId,
      MajorId,
      UniversityId,
      CurrentTerm,
      Fid,
      MemberCode,
      Gender,
      DOB,
      Phone,
    } = req.body;

    await pool.query(
      `
      UPDATE "Users" 
      SET 
        "Name" = $1, "Email" = $2, "Role" = $3, "StudentId" = $4,
        "MajorId" = $5, "UniversityId" = $6, "CurrentTerm" = $7,
        "Fid" = $8, "MemberCode" = $9, "Gender" = $10,
        "DOB" = $11, "Phone" = $12
      WHERE "Id" = $13
    `,
      [
        Name || null,
        Email || null,
        Role || "user",
        StudentId || null,
        MajorId || null,
        UniversityId || null,
        CurrentTerm || null,
        Fid || null,
        MemberCode || null,
        Gender || null,
        DOB ? new Date(DOB) : null,
        Phone || null,
        id,
      ],
    );

    res.json({ success: true, message: "Cập nhật thành công!" });
  } catch (error) {
    console.error("Lỗi cập nhật user:", error);
    res
      .status(500)
      .json({ success: false, message: "Lỗi hệ thống khi cập nhật!" });
  }
};

exports.deleteUser = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    await client.query(`DELETE FROM "UCDocuments" WHERE "CreatedById" = $1`, [
      id,
    ]);
    await client.query(`DELETE FROM "UCCodePushes" WHERE "PushedById" = $1`, [
      id,
    ]);
    await client.query(`DELETE FROM "TaskAssignments" WHERE "UserId" = $1`, [
      id,
    ]);
    await client.query(`DELETE FROM "Requests" WHERE "SenderId" = $1`, [id]);
    await client.query(
      `DELETE FROM "Notifications" WHERE "UserId" = $1 OR "SenderId" = $1`,
      [id],
    );
    await client.query(`DELETE FROM "GroupMembers" WHERE "UserId" = $1`, [id]);
    await client.query(`DELETE FROM "Users" WHERE "Id" = $1`, [id]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Đã xóa tài khoản và dọn sạch dữ liệu liên quan thành công!",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      "Lỗi xóa user:",
      error.message,
      "| Table:",
      error.table,
      "| Detail:",
      error.detail,
    );
    res
      .status(500)
      .json({ success: false, message: "Lỗi hệ thống khi xóa user!" });
  } finally {
    if (client) client.release();
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    await pool.query(`UPDATE "Users" SET "Status" = $1 WHERE "Id" = $2`, [
      status,
      id,
    ]);
    res.json({ success: true, message: "Cập nhật trạng thái thành công!" });
  } catch (err) {
    console.error("Lỗi cập nhật trạng thái:", err);
    res.status(500).json({ success: false, message: "Lỗi hệ thống!" });
  }
};

// ============================================================
// GROUPS — Hỗ trợ search, sort, paging
// ============================================================
exports.getAdminGroups = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || "";
    const status = req.query.status || ""; // "active" | "suspended" | ""
    const sortBy = req.query.sortBy || "CreatedAt";
    const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
    const allowedSort = [
      "Name",
      "ClassName",
      "Semester",
      "memberCount",
      "taskCount",
      "lastActivity",
      "CreatedAt",
    ];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : "CreatedAt";

    const offset = (page - 1) * limit;
    const sp = `%${search}%`;

    // Count query
    const countRes = await pool.query(
      `
      SELECT COUNT(DISTINCT g."Id") as total
      FROM "Groups" g
      LEFT JOIN "Subjects" s ON s."SubjectCode" = g."SubjectCode"
      WHERE (g."Name" ILIKE $1 OR g."ClassName" ILIKE $1 OR s."SubjectName" ILIKE $1 OR g."SubjectCode" ILIKE $1)
      AND ($2 = '' OR (CASE WHEN $2 = 'active' THEN COALESCE(g."IsActive"::int, 1) = 1 ELSE COALESCE(g."IsActive"::int, 1) = 0 END))
    `,
      [sp, status],
    );

    const total = parseInt(countRes.rows[0].total);

    // Data query — sort on alias requires subquery trick
    const dataRes = await pool.query(
      `
      SELECT * FROM (
        SELECT
          g."Id", g."Name", g."ClassName", g."Semester", g."Description", g."CreatedAt",
          g."SubjectCode", s."SubjectName",
          COUNT(DISTINCT gm."UserId")::int as "memberCount",
          COUNT(DISTINCT t."Id")::int      as "taskCount",
          MAX(t."CreatedAt")               as "lastActivity",
          MAX(u."Name")                    as "createdByName",
          COALESCE(MAX(g."IsActive"::int), 1) as "IsActive"
        FROM "Groups" g
        LEFT JOIN "Subjects" s      ON s."SubjectCode" = g."SubjectCode"
        LEFT JOIN "GroupMembers" gm ON gm."GroupId" = g."Id"
        LEFT JOIN "Tasks" t         ON t."GroupId" = g."Id"
        LEFT JOIN "Users" u         ON u."Id" = g."CreatedBy"
        WHERE (g."Name" ILIKE $1 OR g."ClassName" ILIKE $1 OR s."SubjectName" ILIKE $1 OR g."SubjectCode" ILIKE $1)
        AND ($2 = '' OR (CASE WHEN $2 = 'active' THEN COALESCE(g."IsActive"::int, 1) = 1 ELSE COALESCE(g."IsActive"::int, 1) = 0 END))
        GROUP BY g."Id", g."Name", g."ClassName", g."Semester", g."Description",
                 g."CreatedAt", g."SubjectCode", s."SubjectName"
      ) sub
      ORDER BY "${safeSortBy}" ${sortDir}
      OFFSET $3 LIMIT $4
    `,
      [sp, status, offset, limit],
    );

    res.json({ success: true, data: dataRes.rows, total, page, limit });
  } catch (err) {
    console.error("getAdminGroups:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.updateGroupStatus = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const isActive = req.body.isActive ? true : false;
    await pool.query(`UPDATE "Groups" SET "IsActive" = $1 WHERE "Id" = $2`, [
      isActive,
      id,
    ]);
    res.json({ success: true, message: "Đã cập nhật trạng thái nhóm!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.sendGroupWarning = async (req, res) => {
  try {
    const { groupId, title, message } = req.body;

    if (!groupId || !title || !message) {
      return res
        .status(400)
        .json({ success: false, message: "Vui lòng nhập đủ thông tin!" });
    }

    await pool.query(
      `
      INSERT INTO "Notifications"("UserId", "GroupId", "Title", "Message", "IsRead", "Type", "CreatedAt")
      SELECT "UserId", $1, $2, $3, false, 'warning', NOW()
      FROM "GroupMembers" WHERE "GroupId" = $1
    `,
      [groupId, title, message],
    );

    await emailService.sendGroupWarningEmail({ groupId, title, message });

    res.json({
      success: true,
      message: "Đã gửi cảnh báo in-app và email tới nhóm!",
    });
  } catch (err) {
    console.error("Lỗi sendGroupWarning:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server: " + err.message });
  }
};

// ============================================================
// UNIVERSITIES
// ============================================================
exports.getUniversities = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.*, COUNT(usr."Id") as "userCount"
      FROM "Universities" u
      LEFT JOIN "Users" usr ON usr."UniversityId" = u."Id"
      GROUP BY u."Id", u."Name", u."LogoUrl", u."WebsiteLink", u."LinkStatus"
      ORDER BY u."Name"
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi getUniversities:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.createUniversity = async (req, res) => {
  try {
    const { name, logoUrl, websiteLink } = req.body;
    if (!name)
      return res
        .status(400)
        .json({ success: false, message: "Tên trường không được để trống!" });

    const result = await pool.query(
      `
      INSERT INTO "Universities"("Name", "LogoUrl", "WebsiteLink", "LinkStatus")
      VALUES($1, $2, $3, true)
      RETURNING *
    `,
      [name, logoUrl || null, websiteLink || null],
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("Lỗi createUniversity:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.updateUniversity = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, logoUrl, websiteLink, linkStatus } = req.body;
    await pool.query(
      `
      UPDATE "Universities"
      SET "Name"=$1, "LogoUrl"=$2, "WebsiteLink"=$3, "LinkStatus"=$4
      WHERE "Id"=$5
    `,
      [
        name,
        logoUrl || null,
        websiteLink || null,
        linkStatus ? true : false,
        id,
      ],
    );

    res.json({ success: true, message: "Đã cập nhật trường học!" });
  } catch (err) {
    console.error("Lỗi updateUniversity:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.deleteUniversity = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const check = await pool.query(
      `SELECT COUNT(*) as cnt FROM "Users" WHERE "UniversityId" = $1`,
      [id],
    );

    if (parseInt(check.rows[0].cnt) > 0)
      return res.status(400).json({
        success: false,
        message: "Không thể xóa: Trường này đang có người dùng liên kết!",
      });

    await pool.query(`DELETE FROM "Universities" WHERE "Id" = $1`, [id]);
    res.json({ success: true, message: "Đã xóa trường học!" });
  } catch (err) {
    console.error("Lỗi deleteUniversity:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ============================================================
// SUBJECTS
// ============================================================
exports.getSubjects = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.*, 
        m."Name" as "MajorName", 
        m."Id" as "MajorId",
        u."Name" as "UniversityName",
        u."Id" as "UniversityId",
        COUNT(DISTINCT g."Id")::int as "groupCount"
      FROM "Subjects" s
      LEFT JOIN "SubjectMajors" sm ON s."SubjectCode" = sm."SubjectCode"
      LEFT JOIN "Majors" m ON sm."MajorId" = m."Id"
      LEFT JOIN "Universities" u ON m."UniversityId" = u."Id"
      LEFT JOIN "Groups" g ON g."SubjectCode" = s."SubjectCode"
      GROUP BY s."SubjectCode", s."SubjectName", s."Semester", s."Id", m."Name", m."Id", u."Name", u."Id"
      ORDER BY s."Id" DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi getSubjects:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server: " + err.message });
  }
};

exports.createSubject = async (req, res) => {
  const client = await pool.connect();
  try {
    const { subjectCode, subjectName, semester, majorId } = req.body;

    if (!subjectCode || !subjectName || !majorId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập đầy đủ Mã môn, Tên môn và chọn Ngành học!",
      });
    }

    const dup = await pool.query(
      `SELECT "SubjectCode" FROM "Subjects" WHERE "SubjectCode" = $1`,
      [subjectCode],
    );
    if (dup.rows.length > 0) {
      return res
        .status(409)
        .json({ success: false, message: "Mã môn học đã tồn tại!" });
    }

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO "Subjects" ("SubjectCode", "SubjectName", "Semester") 
      VALUES ($1, $2, $3)
    `,
      [subjectCode, subjectName, semester || null],
    );

    await client.query(
      `
      INSERT INTO "SubjectMajors" ("SubjectCode", "MajorId") 
      VALUES ($1, $2)
    `,
      [subjectCode, majorId],
    );

    await client.query("COMMIT");
    res.status(201).json({
      success: true,
      message: "Đã thêm môn học và liên kết với ngành!",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Lỗi createSubject:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server: " + err.message });
  } finally {
    client.release();
  }
};

exports.updateSubject = async (req, res) => {
  const client = await pool.connect();
  try {
    const { code } = req.params;
    const { subjectName, semester, majorId } = req.body;

    await client.query("BEGIN");
    await client.query(
      `UPDATE "Subjects" SET "SubjectName"=$1, "Semester"=$2 WHERE "SubjectCode"=$3`,
      [subjectName, semester || null, code],
    );
    if (majorId) {
      await client.query(
        `DELETE FROM "SubjectMajors" WHERE "SubjectCode" = $1`,
        [code],
      );
      await client.query(
        `INSERT INTO "SubjectMajors" ("SubjectCode", "MajorId") VALUES ($1, $2)`,
        [code, majorId],
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, message: "Đã cập nhật môn học!" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Lỗi updateSubject:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  } finally {
    client.release();
  }
};

exports.deleteSubject = async (req, res) => {
  try {
    const { code } = req.params;
    const check = await pool.query(
      `SELECT COUNT(*) as cnt FROM "Groups" WHERE "SubjectCode" = $1`,
      [code],
    );
    if (parseInt(check.rows[0].cnt) > 0)
      return res.status(400).json({
        success: false,
        message: "Không thể xóa: Môn học này đang có nhóm liên kết!",
      });

    await pool.query(`DELETE FROM "SubjectMajors" WHERE "SubjectCode" = $1`, [
      code,
    ]);
    await pool.query(`DELETE FROM "Subjects" WHERE "SubjectCode" = $1`, [code]);
    res.json({ success: true, message: "Đã xóa môn học!" });
  } catch (err) {
    console.error("Lỗi deleteSubject:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ============================================================
// MAJORS
// ============================================================
exports.getMajors = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, COUNT(u."Id")::int as "userCount"
      FROM "Majors" m
      LEFT JOIN "Users" u ON u."MajorId" = m."Id"
      GROUP BY m."Id", m."MajorCode", m."Name"
      ORDER BY m."Name"
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi getMajors:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.createMajor = async (req, res) => {
  try {
    const { majorCode, name } = req.body;
    if (!name)
      return res
        .status(400)
        .json({ success: false, message: "Tên ngành không được để trống!" });

    const result = await pool.query(
      `
      INSERT INTO "Majors"("MajorCode", "Name") 
      VALUES($1, $2)
      RETURNING *
    `,
      [majorCode || null, name],
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("Lỗi createMajor:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.updateMajor = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { majorCode, name } = req.body;
    await pool.query(
      `UPDATE "Majors" SET "MajorCode"=$1, "Name"=$2 WHERE "Id"=$3`,
      [majorCode || null, name, id],
    );
    res.json({ success: true, message: "Đã cập nhật ngành học!" });
  } catch (err) {
    console.error("Lỗi updateMajor:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.deleteMajor = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const check = await pool.query(
      `SELECT COUNT(*) as cnt FROM "Users" WHERE "MajorId" = $1`,
      [id],
    );
    if (parseInt(check.rows[0].cnt) > 0)
      return res.status(400).json({
        success: false,
        message: "Không thể xóa: Ngành này đang có người dùng liên kết!",
      });

    await pool.query(`DELETE FROM "Majors" WHERE "Id" = $1`, [id]);
    res.json({ success: true, message: "Đã xóa ngành học!" });
  } catch (err) {
    console.error("Lỗi deleteMajor:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ============================================================
// LECTURERS
// ============================================================
exports.getLecturers = async (req, res) => {
  try {
    const search = req.query.search || "";
    const sp = `%${search}%`;

    const result = await pool.query(
      `SELECT l.*, u."Name" as "UniversityName"
       FROM "Lecturers" l
       LEFT JOIN "Universities" u ON u."Id" = l."UniversityId"
       WHERE $1 = '%%' OR l."Name" ILIKE $1 OR l."LecturerCode" ILIKE $1
       ORDER BY l."Name"`,
      [sp],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi getLecturers:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.createLecturer = async (req, res) => {
  try {
    const { lecturerCode, name, phone, email, universityId } = req.body;
    if (!name)
      return res.status(400).json({
        success: false,
        message: "Tên giảng viên không được để trống!",
      });

    const result = await pool.query(
      `
      INSERT INTO "Lecturers"("LecturerCode", "Name", "Phone", "Email", "UniversityId", "IsActive")
      VALUES($1, $2, $3, $4, $5, true)
      RETURNING *
    `,
      [
        lecturerCode || null,
        name,
        phone || null,
        email || null,
        universityId ? parseInt(universityId) : null,
      ],
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("Lỗi createLecturer:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.updateLecturer = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { lecturerCode, name, phone, email, universityId, isActive } =
      req.body;

    await pool.query(
      `
      UPDATE "Lecturers"
      SET "LecturerCode"=$1, "Name"=$2, "Phone"=$3, "Email"=$4, "UniversityId"=$5, "IsActive"=$6
      WHERE "Id"=$7
    `,
      [
        lecturerCode || null,
        name,
        phone || null,
        email || null,
        universityId ? parseInt(universityId) : null,
        isActive ? true : false,
        id,
      ],
    );

    res.json({ success: true, message: "Đã cập nhật giảng viên!" });
  } catch (err) {
    console.error("Lỗi updateLecturer:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.deleteLecturer = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query(`DELETE FROM "Lecturers" WHERE "Id" = $1`, [id]);
    res.json({ success: true, message: "Đã xóa giảng viên!" });
  } catch (err) {
    console.error("Lỗi deleteLecturer:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ============================================================
// SYSTEM NOTIFICATIONS
// ============================================================
exports.sendSystemNotification = async (req, res) => {
  try {
    const { target, targetId, title, message, type = "system" } = req.body;
    if (!title || !message)
      return res.status(400).json({
        success: false,
        message: "Vui lòng điền tiêu đề và nội dung!",
      });

    let emails = [];

    if (target === "all") {
      await pool.query(
        `
        INSERT INTO "Notifications"("UserId", "GroupId", "Title", "Message", "IsRead", "Type", "CreatedAt")
        SELECT "Id", NULL, $1, $2, false, $3, NOW()
        FROM "Users" WHERE COALESCE("Status",'active') = 'active'
      `,
        [title, message, type],
      );
      const eRes = await pool.query(
        `SELECT "Email" FROM "Users" WHERE "Email" IS NOT NULL AND "Email" != '' AND COALESCE("Status",'active') = 'active'`,
      );
      emails = eRes.rows.map((r) => r.Email);
    } else if (target === "group") {
      await pool.query(
        `
        INSERT INTO "Notifications"("UserId", "GroupId", "Title", "Message", "IsRead", "Type", "CreatedAt")
        SELECT "UserId", $1, $2, $3, false, $4, NOW()
        FROM "GroupMembers" WHERE "GroupId" = $1
      `,
        [parseInt(targetId), title, message, type],
      );
    } else if (target === "user") {
      await pool.query(
        `
        INSERT INTO "Notifications"("UserId", "GroupId", "Title", "Message", "IsRead", "Type", "CreatedAt")
        VALUES($1, NULL, $2, $3, false, $4, NOW())
      `,
        [parseInt(targetId), title, message, type],
      );
      const eRes = await pool.query(
        `SELECT "Email" FROM "Users" WHERE "Id" = $1 AND "Email" IS NOT NULL AND "Email" != ''`,
        [parseInt(targetId)],
      );
      emails = eRes.rows.map((r) => r.Email);
    }

    if (emails.length > 0) {
      await emailService.sendSystemNotificationEmail({
        emails,
        title,
        message,
      });
    }

    res.json({ success: true, message: "Đã gửi thông báo thành công!" });
  } catch (err) {
    console.error("sendSystemNotification:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ============================================================
// FEEDBACK & REQUESTS — Hỗ trợ search, sort, paging
// ============================================================
exports.getAllRequests = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || "";
    const status = req.query.status || "";
    const formType = req.query.formType || "";
    const sortBy = req.query.sortBy || "CreatedAt";
    const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
    const allowedSort = ["SenderName", "FormType", "Status", "CreatedAt"];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : "CreatedAt";

    const offset = (page - 1) * limit;
    const sp = `%${search}%`;

    const countRes = await pool.query(
      `
      SELECT COUNT(*) as total
      FROM "Requests" r
      LEFT JOIN "Users" u ON u."Id" = r."SenderId"
      WHERE ($1 = '' OR u."Name" ILIKE $1 OR u."Email" ILIKE $1 OR r."Reason" ILIKE $1)
      AND ($2 = '' OR r."Status" = $2)
      AND ($3 = '' OR r."FormType" = $3)
    `,
      [sp, status, formType],
    );

    const dataRes = await pool.query(
      `
      SELECT r.*, u."Name" as "SenderName", u."Email" as "SenderEmail", u."AvatarUrl"
      FROM "Requests" r
      LEFT JOIN "Users" u ON u."Id" = r."SenderId"
      WHERE ($1 = '' OR u."Name" ILIKE $1 OR u."Email" ILIKE $1 OR r."Reason" ILIKE $1)
      AND ($2 = '' OR r."Status" = $2)
      AND ($3 = '' OR r."FormType" = $3)
      ORDER BY r."${safeSortBy}" ${sortDir}
      OFFSET $4 LIMIT $5
    `,
      [sp, status, formType, offset, limit],
    );

    res.json({
      success: true,
      data: dataRes.rows,
      total: parseInt(countRes.rows[0].total),
      page,
      limit,
    });
  } catch (err) {
    console.error("Lỗi getAllRequests:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.resolveRequest = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, resolveNote } = req.body;
    const resolverId = req.user.id;
    await pool.query(
      `
      UPDATE "Requests"
      SET "Status"=$1, "ResolveNote"=$2, "ResolverId"=$3, "ResolvedAt"=NOW()
      WHERE "Id"=$4
    `,
      [status, resolveNote || null, resolverId, id],
    );
    res.json({ success: true, message: "Đã xử lý đơn!" });
  } catch (err) {
    console.error("Lỗi resolveRequest:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// Search users (for notification target picker)
exports.searchUsers = async (req, res) => {
  try {
    const raw = (req.query.q || "").replace(/[%_[\]]/g, "\\$&");
    const sp = `%${raw}%`;
    if (!raw) return res.json({ success: true, data: [] });

    const result = await pool.query(
      `
      SELECT "Id", "Name", "Email", "AvatarUrl", "Role" FROM "Users"
      WHERE "Name" ILIKE $1 OR "Email" ILIKE $1
      LIMIT 10
    `,
      [sp],
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi searchUsers:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ============================================================
// GROUP REQUESTS — Hỗ trợ search, sort, paging
// ============================================================
exports.getGroupRequests = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || "";
    const status = req.query.status || "";
    const sortBy = req.query.sortBy || "CreatedAt";
    const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
    const allowedSort = ["GroupName", "CreatorName", "Status", "CreatedAt"];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : "CreatedAt";

    const offset = (page - 1) * limit;
    const sp = `%${search}%`;

    const countRes = await pool.query(
      `
      SELECT COUNT(*) as total
      FROM "GroupRequests" gr
      LEFT JOIN "Users" u ON gr."CreatedBy" = u."Id"
      LEFT JOIN "Subjects" s ON gr."SubjectCode" = s."SubjectCode"
      WHERE ($1 = '' OR gr."GroupName" ILIKE $1 OR u."Name" ILIKE $1 OR gr."SubjectCode" ILIKE $1 OR s."SubjectName" ILIKE $1)
      AND ($2 = '' OR gr."Status" = $2)
    `,
      [sp, status],
    );

    const dataRes = await pool.query(
      `
      SELECT 
        gr.*, 
        u."Name" as "CreatorName", 
        u."Email" as "CreatorEmail",
        s."SubjectName"
      FROM "GroupRequests" gr
      LEFT JOIN "Users" u ON gr."CreatedBy" = u."Id"
      LEFT JOIN "Subjects" s ON gr."SubjectCode" = s."SubjectCode"
      WHERE ($1 = '' OR gr."GroupName" ILIKE $1 OR u."Name" ILIKE $1 OR gr."SubjectCode" ILIKE $1 OR s."SubjectName" ILIKE $1)
      AND ($2 = '' OR gr."Status" = $2)
      ORDER BY
        CASE WHEN $3 = 'Status' AND $4 = 'ASC' THEN gr."Status" END ASC,
        CASE WHEN $3 = 'Status' AND $4 = 'DESC' THEN gr."Status" END DESC,
        CASE WHEN $3 = 'GroupName' AND $4 = 'ASC' THEN gr."GroupName" END ASC,
        CASE WHEN $3 = 'GroupName' AND $4 = 'DESC' THEN gr."GroupName" END DESC,
        CASE WHEN $3 = 'CreatorName' AND $4 = 'ASC' THEN u."Name" END ASC,
        CASE WHEN $3 = 'CreatorName' AND $4 = 'DESC' THEN u."Name" END DESC,
        CASE WHEN $3 = 'CreatedAt' OR $3 NOT IN ('Status','GroupName','CreatorName') THEN gr."CreatedAt" END DESC
      OFFSET $5 LIMIT $6
    `,
      [sp, status, safeSortBy, sortDir, offset, limit],
    );

    res.json({
      success: true,
      data: dataRes.rows,
      total: parseInt(countRes.rows[0].total),
      page,
      limit,
    });
  } catch (error) {
    console.error("Lỗi lấy danh sách đơn xin tạo nhóm:", error);
    res
      .status(500)
      .json({ success: false, message: "Lỗi hệ thống khi tải đơn tạo nhóm!" });
  }
};

// [PUT] Admin duyệt hoặc từ chối yêu cầu tạo nhóm
exports.resolveGroupRequest = async (req, res) => {
  const client = await pool.connect();
  try {
    const requestId = parseInt(req.params.id);
    const { isApproved, adminNote } = req.body;
    const adminId = req.user.id;

    await client.query("BEGIN");

    const requestRes = await client.query(
      `
      SELECT * FROM "GroupRequests" WHERE "Id" = $1 AND "Status" = 'pending' FOR UPDATE
    `,
      [requestId],
    );

    if (requestRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hoặc đã được xử lý!",
      });
    }
    const groupReq = requestRes.rows[0];

    let newGroupId = null;
    let addedMemberIds = [];

    if (isApproved) {
      const groupInsertRes = await client.query(
        `
        INSERT INTO "Groups" ("Name", "SubjectCode", "ClassName", "Semester", "GroupNumber", "TermNumber", "Description", "CreatedBy", "CreatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING "Id"
      `,
        [
          groupReq.GroupName,
          groupReq.SubjectCode,
          groupReq.ClassName,
          groupReq.Semester,
          groupReq.GroupNumber,
          groupReq.TermNumber || null,
          groupReq.Description || "",
          groupReq.CreatedBy,
        ],
      );
      newGroupId = groupInsertRes.rows[0].Id;

      await client.query(
        `
        INSERT INTO "GroupMembers" ("GroupId", "UserId", "GroupRole", "JoinedAt")
        VALUES ($1, $2, 'Leader', NOW())
      `,
        [newGroupId, groupReq.CreatedBy],
      );
      addedMemberIds.push(groupReq.CreatedBy);

      if (groupReq.MemberEmails) {
        const emails = JSON.parse(groupReq.MemberEmails);
        for (const email of emails) {
          const oldUsersRes = await client.query(
            `SELECT "Id" FROM "Users" WHERE "Email" = $1`,
            [email],
          );
          if (oldUsersRes.rows.length > 0) {
            const uId = oldUsersRes.rows[0].Id;
            if (uId !== groupReq.CreatedBy) {
              await client.query(
                `
                INSERT INTO "GroupMembers" ("GroupId", "UserId", "GroupRole", "JoinedAt") 
                VALUES ($1, $2, 'User', NOW())
              `,
                [newGroupId, uId],
              );
              addedMemberIds.push(uId);
            }
          }
        }
      }

      if (groupReq.NewAccountRequestsJson) {
        const newAccounts = JSON.parse(groupReq.NewAccountRequestsJson);
        const salt = await bcrypt.genSalt(10);
        const defaultPass = await bcrypt.hash("123456", salt);

        for (const acc of newAccounts) {
          const newAccRes = await client.query(
            `
            INSERT INTO "Users" ("Email", "Name", "StudentId", "PasswordHash", "Role", "Status", "CreatedAt")
            VALUES ($1, $2, $3, $4, 'user', 'active', NOW())
            RETURNING "Id"
          `,
            [acc.email, acc.fullName, acc.studentId, defaultPass],
          );
          const newUserId = newAccRes.rows[0].Id;

          await client.query(
            `
            INSERT INTO "GroupMembers" ("GroupId", "UserId", "GroupRole", "JoinedAt") 
            VALUES ($1, $2, 'User', NOW())
          `,
            [newGroupId, newUserId],
          );
          addedMemberIds.push(newUserId);
          emailService
            .sendNewAccountEmail({
              email: acc.email,
              name: acc.fullName,
              password: "123456",
              loginUrl: process.env.FRONTEND_URL,
            })
            .catch(() => {});
        }
      }
    }

    const newStatus = isApproved ? "approved" : "rejected";
    await client.query(
      `
      UPDATE "GroupRequests" 
      SET "Status" = $1, "AdminNote" = $2, "UpdatedAt" = NOW() 
      WHERE "Id" = $3
    `,
      [newStatus, adminNote || "", requestId],
    );

    await client.query("COMMIT");

    if (isApproved) {
      createNotifications({
        userIds: addedMemberIds,
        title: `Nhóm "${groupReq.GroupName}" đã sẵn sàng!`,
        message: `Yêu cầu tạo nhóm <strong>${groupReq.GroupName}</strong> đã được phê duyệt.`,
        type: "group",
        senderId: adminId,
        referenceId: newGroupId,
      });

      addedMemberIds.forEach((mId) => {
        emailService.sendMemberAddedEmail({
          userId: mId,
          groupId: newGroupId,
          groupName: groupReq.GroupName,
          addedByName: "Hệ thống (Admin)",
          groupUrl: `${process.env.FRONTEND_URL}/group/${newGroupId}`,
        });
      });
    }

    res.json({
      success: true,
      message: isApproved
        ? "Đã duyệt và thông báo cho sinh viên!"
        : "Đã từ chối đơn!",
    });
  } catch (err) {
    console.error("Lỗi resolveGroupRequest:", err);
    if (client) await client.query("ROLLBACK");
    res.status(500).json({ success: false, message: "Lỗi hệ thống!" });
  } finally {
    if (client) client.release();
  }
};

// [GET] Tìm kiếm vạn năng
exports.globalSearch = async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword) return res.json({ success: true, users: [], groups: [] });
    const searchParam = `%${keyword}%`;

    const users = await pool.query(
      `
      SELECT "Id", "Name", "Email", "StudentId", "Role", "Status", "AvatarUrl", "Fid"
      FROM "Users" 
      WHERE CAST("Id" AS VARCHAR) = $1
         OR "StudentId" ILIKE $2
         OR "Email" ILIKE $2
         OR "Name" ILIKE $2
         OR "Fid" ILIKE $2
    `,
      [keyword, searchParam],
    );

    const groups = await pool.query(
      `
      SELECT "Id", "Name", "ClassName", "SubjectCode", "Semester", "IsActive" 
      FROM "Groups" 
      WHERE CAST("Id" AS VARCHAR) = $1
         OR "Name" ILIKE $2
         OR "SubjectCode" ILIKE $2
    `,
      [keyword, searchParam],
    );

    res.json({ success: true, users: users.rows, groups: groups.rows });
  } catch (err) {
    console.error("Lỗi globalSearch:", err);
    res.status(500).json({ success: false, message: "Lỗi tìm kiếm!" });
  }
};
