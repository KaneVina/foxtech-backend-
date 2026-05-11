const { pool } = require("../config/db");

exports.getUniversities = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT "Id", "Name", "LogoUrl", "WebsiteLink", "LinkStatus" FROM "Universities" WHERE "LinkStatus" = true`,
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi lấy danh sách trường học" });
  }
};

exports.getMajors = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT "Id", "MajorCode", "Name" FROM "Majors"`,
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi lấy danh sách chuyên ngành" });
  }
};

exports.getLecturers = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l."Id", l."LecturerCode", l."Name", l."Phone", l."Email", l."IsActive", u."Name" as "UniversityName"
      FROM "Lecturers" l
      LEFT JOIN "Universities" u ON l."UniversityId" = u."Id"
    `);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi lấy danh sách giảng viên" });
  }
};
