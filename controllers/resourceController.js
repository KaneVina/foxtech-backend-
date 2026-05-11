const { pool } = require("../config/db");

// 1. Lấy danh sách môn học theo Kỳ (giữ lại để tương thích)
exports.getSubjectsBySemester = async (req, res) => {
  try {
    const { semester } = req.params;
    const result = await pool.query(
      `SELECT * FROM "Subjects" WHERE "Semester" = $1`,
      [semester],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// 2. Lấy TẤT CẢ môn học của ngành người dùng đang học
//    Route: GET /resources/my-subjects
exports.getMySubjects = async (req, res) => {
  try {
    const majorId = req.user.majorId;

    // Nếu user chưa được gán ngành → trả về mảng rỗng kèm thông báo
    if (!majorId) {
      return res.json({
        success: true,
        data: [],
        warningType: "no_major",
        warning:
          "Tài khoản chưa được gán ngành học. Liên hệ admin để cập nhật!",
      });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM "SubjectMajors" WHERE "MajorId" = $1`,
      [majorId],
    );
    const linkedCount = parseInt(countResult.rows[0].cnt);

    if (linkedCount === 0) {
      return res.json({
        success: true,
        data: [],
        warningType: "no_subjects_linked",
        warning:
          "Ngành học của bạn chưa được liên kết với môn học nào. Admin cần thêm dữ liệu vào bảng SubjectMajors!",
      });
    }

    const result = await pool.query(
      `
      SELECT DISTINCT
        s."SubjectCode",
        s."SubjectName",
        s."SubjectNameVN",
        s."Semester",
        m."Name"        AS "MajorName",
        m."MajorCode"   AS "MajorCode",
        uni."Name"      AS "UniversityName",
        uni."LogoUrl"   AS "UniversityLogoUrl"
      FROM "Subjects" s
      JOIN "SubjectMajors" sm  ON s."SubjectCode"  = sm."SubjectCode"
      JOIN "Majors"        m   ON sm."MajorId"     = m."Id"
      JOIN "Universities"  uni ON m."UniversityId" = uni."Id"
      WHERE sm."MajorId" = $1
      ORDER BY s."Semester" ASC, s."SubjectCode" ASC
    `,
      [majorId],
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi getMySubjects:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// 3. Tìm kiếm toàn cục (môn học, thư mục, tài liệu)
//    Route: GET /resources/search?q=keyword
exports.globalSearch = async (req, res) => {
  try {
    const { q } = req.query;
    const majorId = req.user.majorId;

    if (!q || q.trim().length < 2) {
      return res.json({ success: true, subjects: [], folders: [], files: [] });
    }

    const keyword = `%${q.trim()}%`;

    // Tìm môn học (chỉ trong ngành của user)
    let subjectQuery;
    if (majorId) {
      subjectQuery = await pool.query(
        `
        SELECT DISTINCT s."SubjectCode", s."SubjectName", s."SubjectNameVN", s."Semester"
        FROM "Subjects" s
        JOIN "SubjectMajors" sm ON s."SubjectCode" = sm."SubjectCode"
        WHERE sm."MajorId" = $1
          AND (s."SubjectCode" ILIKE $2 OR s."SubjectName" ILIKE $2 OR s."SubjectNameVN" ILIKE $2)
      `,
        [majorId, keyword],
      );
    } else {
      subjectQuery = await pool.query(
        `
        SELECT "SubjectCode", "SubjectName", "SubjectNameVN", "Semester"
        FROM "Subjects"
        WHERE "SubjectCode" ILIKE $1 OR "SubjectName" ILIKE $1 OR "SubjectNameVN" ILIKE $1
      `,
        [keyword],
      );
    }

    // Tìm thư mục (trong ngành của user)
    let folderQuery;
    if (majorId) {
      folderQuery = await pool.query(
        `
        SELECT rf."Id", rf."Name", rf."SubjectCode", s."SubjectName", s."Semester"
        FROM "ResourceFolders" rf
        JOIN "Subjects" s ON rf."SubjectCode" = s."SubjectCode"
        JOIN "SubjectMajors" sm ON s."SubjectCode" = sm."SubjectCode"
        WHERE sm."MajorId" = $1
          AND rf."Name" ILIKE $2
        ORDER BY rf."CreatedAt" DESC
      `,
        [majorId, keyword],
      );
    } else {
      folderQuery = await pool.query(
        `
        SELECT rf."Id", rf."Name", rf."SubjectCode", s."SubjectName", s."Semester"
        FROM "ResourceFolders" rf
        JOIN "Subjects" s ON rf."SubjectCode" = s."SubjectCode"
        WHERE rf."Name" ILIKE $1
        ORDER BY rf."CreatedAt" DESC
      `,
        [keyword],
      );
    }

    // Tìm tài liệu/file
    let fileQuery;
    if (majorId) {
      fileQuery = await pool.query(
        `
        SELECT
          f."Id", f."Title", f."FileUrl", f."CreatedAt",
          rf."Name" AS "FolderName", rf."Id" AS "FolderId",
          s."SubjectCode", s."SubjectName", s."Semester",
          u."Name" AS "AddedByName"
        FROM "ResourceFiles" f
        JOIN "ResourceFolders" rf ON f."FolderId" = rf."Id"
        JOIN "Subjects" s ON rf."SubjectCode" = s."SubjectCode"
        JOIN "SubjectMajors" sm ON s."SubjectCode" = sm."SubjectCode"
        JOIN "Users" u ON f."AddedBy" = u."Id"
        WHERE sm."MajorId" = $1
          AND (f."Title" ILIKE $2 OR u."Name" ILIKE $2)
        ORDER BY f."CreatedAt" DESC
        LIMIT 20
      `,
        [majorId, keyword],
      );
    } else {
      fileQuery = await pool.query(
        `
        SELECT
          f."Id", f."Title", f."FileUrl", f."CreatedAt",
          rf."Name" AS "FolderName", rf."Id" AS "FolderId",
          s."SubjectCode", s."SubjectName", s."Semester",
          u."Name" AS "AddedByName"
        FROM "ResourceFiles" f
        JOIN "ResourceFolders" rf ON f."FolderId" = rf."Id"
        JOIN "Subjects" s ON rf."SubjectCode" = s."SubjectCode"
        JOIN "Users" u ON f."AddedBy" = u."Id"
        WHERE f."Title" ILIKE $1 OR u."Name" ILIKE $1
        ORDER BY f."CreatedAt" DESC
        LIMIT 20
      `,
        [keyword],
      );
    }

    res.json({
      success: true,
      subjects: subjectQuery.rows,
      folders: folderQuery.rows,
      files: fileQuery.rows,
    });
  } catch (err) {
    console.error("Lỗi globalSearch:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// 4. Lấy danh sách Thư mục của 1 Môn học
exports.getFolders = async (req, res) => {
  try {
    const { subjectCode } = req.params;
    const result = await pool.query(
      `SELECT * FROM "ResourceFolders" WHERE "SubjectCode" = $1 ORDER BY "CreatedAt" DESC`,
      [subjectCode],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// 5. Tạo Thư mục mới
exports.createFolder = async (req, res) => {
  try {
    const { name, subjectCode } = req.body;
    const userId = req.user.id || req.user.Id || req.userId;
    await pool.query(
      `INSERT INTO "ResourceFolders" ("Name", "SubjectCode", "CreatedBy") VALUES ($1, $2, $3)`,
      [name, subjectCode, userId],
    );
    res.json({ success: true, message: "Đã tạo thư mục!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// 6. Lấy danh sách File trong 1 Thư mục
exports.getFiles = async (req, res) => {
  try {
    const { folderId } = req.params;
    const result = await pool.query(
      `
      SELECT f.*, u."Name" as "AddedByName" 
      FROM "ResourceFiles" f 
      JOIN "Users" u ON f."AddedBy" = u."Id" 
      WHERE f."FolderId" = $1 
      ORDER BY f."CreatedAt" DESC
    `,
      [folderId],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// 7. Thêm File/Link mới
exports.createFile = async (req, res) => {
  try {
    const { folderId, title, fileUrl } = req.body;
    const userId = req.user.id || req.user.Id || req.userId;
    await pool.query(
      `INSERT INTO "ResourceFiles" ("FolderId", "Title", "FileUrl", "AddedBy") VALUES ($1, $2, $3, $4)`,
      [folderId, title, fileUrl, userId],
    );
    res.json({ success: true, message: "Đã thêm tài liệu!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// 8. Xóa thư mục (xóa luôn cả file bên trong)
exports.deleteFolder = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM "ResourceFiles" WHERE "FolderId" = $1`, [id]);
    await pool.query(`DELETE FROM "ResourceFolders" WHERE "Id" = $1`, [id]);
    res.json({ success: true, message: "Đã xóa thư mục thành công!" });
  } catch (err) {
    console.error("Lỗi xóa thư mục:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};
// 9. Xóa file
exports.deleteFile = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM "ResourceFiles" WHERE "Id" = $1`, [id]);
    res.json({ success: true, message: "Đã xóa tài liệu!" });
  } catch (err) {
    console.error("Lỗi xóa file:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};
