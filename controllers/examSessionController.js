const { pool } = require("../config/db");
const crypto = require("crypto");

// ─── Helper: sinh mã phiên thi FT_{subjectCode}_{6 ký tự} ────
const generateSessionCode = (subjectCode) => {
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 ký tự hex
  return `FT_${subjectCode}_${rand}`;
};

// ─── Helper: đảm bảo mã unique ───────────────────────────────
const uniqueCode = async (subjectCode) => {
  let code, exists;
  do {
    code = generateSessionCode(subjectCode);
    const r = await pool.query(
      `SELECT 1 FROM "ExamSessions" WHERE "SessionCode" = $1`,
      [code],
    );
    exists = r.rowCount > 0;
  } while (exists);
  return code;
};

// ─── Helper: format submission row ───────────────────────────
const fmtSubmission = (row) => ({
  id: row.Id,
  candidateName: row.CandidateName,
  candidateEmail: row.CandidateEmail,
  status: row.Status,
  forceSubmit: row.ForceSubmit,
  startTime: row.StartTime,
  submitTime: row.SubmitTime,
  actualSeconds: row.ActualSeconds,
});

// ─── Helper: format session row ──────────────────────────────
const fmtSession = (row) => ({
  sessionCode: row.SessionCode,
  subjectCode: row.SubjectCode,
  duration: row.Duration,
  fileTitle: row.FileTitle,
  fileUrl: row.FileUrl,
  scheduledStart: row.ScheduledStart || null,
  createdAt: row.CreatedAt,
});

/* ════════════════════════════════════════════════════════════
   1. Tạo phiên thi  —  POST /api/exam-sessions
════════════════════════════════════════════════════════════ */
exports.createSession = async (req, res) => {
  try {
    const { subjectCode, duration, fileTitle, fileUrl, scheduledStart } =
      req.body;
    const userId = req.user.id || req.user.Id;

    if (!subjectCode || !duration || !fileUrl) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu thông tin bắt buộc" });
    }

    const sessionCode = await uniqueCode(subjectCode.trim().toUpperCase());

    await pool.query(
      `INSERT INTO "ExamSessions"
         ("SessionCode","SubjectCode","Duration","FileTitle","FileUrl","CreatedBy","IsActive","ScheduledStart")
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7)`,
      [
        sessionCode,
        subjectCode.trim().toUpperCase(),
        duration,
        fileTitle,
        fileUrl,
        userId,
        scheduledStart || null,
      ],
    );

    const r = await pool.query(
      `SELECT * FROM "ExamSessions" WHERE "SessionCode" = $1`,
      [sessionCode],
    );

    res.json({
      success: true,
      data: { ...fmtSession(r.rows[0]), submissions: [] },
    });
  } catch (err) {
    console.error("Lỗi createSession:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════════════
   2. Lấy thông tin phiên thi + danh sách thí sinh (polling giám thị)
      GET /api/exam-sessions/:sessionCode
════════════════════════════════════════════════════════════ */
exports.getSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const userId = req.user.id || req.user.Id;

    const sr = await pool.query(
      `SELECT * FROM "ExamSessions" WHERE "SessionCode" = $1 AND "IsActive" = TRUE`,
      [sessionCode],
    );
    if (sr.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Phiên thi không tồn tại hoặc đã kết thúc",
      });
    }
    const session = sr.rows[0];

    // Chỉ createdBy mới thấy danh sách submissions
    if (session.CreatedBy !== userId) {
      return res.status(403).json({
        success: false,
        message: "Bạn không có quyền xem phiên thi này",
      });
    }

    const subr = await pool.query(
      `SELECT es.*,u."Name" AS "CandidateName",u."Email" AS "CandidateEmail"
       FROM "ExamSubmissions" es
       JOIN "Users" u ON es."CandidateId" = u."Id"
       WHERE es."SessionId" = $1
       ORDER BY es."CreatedAt" ASC`,
      [session.Id],
    );

    res.json({
      success: true,
      data: {
        ...fmtSession(session),
        submissions: subr.rows.map(fmtSubmission),
      },
    });
  } catch (err) {
    console.error("Lỗi getSession:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════════════
   3. Thí sinh tham gia phiên thi
      POST /api/exam-sessions/join
════════════════════════════════════════════════════════════ */
exports.joinSession = async (req, res) => {
  try {
    const { sessionCode } = req.body;
    const userId = req.user.id || req.user.Id;

    if (!sessionCode) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu mã đề thi" });
    }

    const sr = await pool.query(
      `SELECT * FROM "ExamSessions" WHERE "SessionCode" = $1 AND "IsActive" = TRUE`,
      [sessionCode.trim().toUpperCase()],
    );
    if (sr.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Mã đề thi không hợp lệ hoặc phiên đã kết thúc",
      });
    }
    const session = sr.rows[0];

    // Idempotent: nếu đã có submission active thì trả về luôn
    const existing = await pool.query(
      `SELECT * FROM "ExamSubmissions"
       WHERE "SessionId" = $1 AND "CandidateId" = $2 AND "Status" = 'active'`,
      [session.Id, userId],
    );
    if (existing.rowCount > 0) {
      return res.json({
        success: true,
        data: {
          submission: fmtSubmission(existing.rows[0]),
          session: fmtSession(session),
        },
      });
    }

    const ins = await pool.query(
      `INSERT INTO "ExamSubmissions"
         ("SessionId","CandidateId","Status","ForceSubmit","StartTime")
       VALUES ($1,$2,'active',FALSE,NOW())
       RETURNING *`,
      [session.Id, userId],
    );

    res.json({
      success: true,
      data: {
        submission: fmtSubmission(ins.rows[0]),
        session: fmtSession(session),
      },
    });
  } catch (err) {
    console.error("Lỗi joinSession:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════════════
   4. Kiểm tra trạng thái submission  (polling force-submit)
      GET /api/exam-sessions/submission/:submissionId/status
════════════════════════════════════════════════════════════ */
exports.getSubmissionStatus = async (req, res) => {
  try {
    const { submissionId } = req.params;

    const r = await pool.query(
      `SELECT "Status","ForceSubmit" FROM "ExamSubmissions" WHERE "Id" = $1`,
      [submissionId],
    );
    if (r.rowCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy submission" });
    }
    const row = r.rows[0];

    res.json({
      success: true,
      forceSubmit: row.ForceSubmit,
      status: row.Status,
    });
  } catch (err) {
    console.error("Lỗi getSubmissionStatus:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════════════
   5. Thí sinh nộp bài
      POST /api/exam-sessions/submission/:submissionId/submit
════════════════════════════════════════════════════════════ */
exports.submitExam = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { actualSeconds, startTime, submitTime, status } = req.body;
    const userId = req.user.id || req.user.Id;

    // Chỉ cập nhật nếu vẫn đang active (tránh double-submit)
    const r = await pool.query(
      `UPDATE "ExamSubmissions"
       SET "Status"=$1,"ActualSeconds"=$2,"StartTime"=$3,"SubmitTime"=$4
       WHERE "Id"=$5 AND "CandidateId"=$6 AND "Status"='active'
       RETURNING *`,
      [
        status || "submitted",
        actualSeconds,
        startTime,
        submitTime || new Date().toISOString(),
        submissionId,
        userId,
      ],
    );

    if (r.rowCount === 0) {
      return res.status(400).json({
        success: false,
        message: "Không thể nộp bài (đã nộp hoặc không hợp lệ)",
      });
    }

    // Lấy thêm name/email để trả về cho client
    const full = await pool.query(
      `SELECT es.*,u."Name" AS "CandidateName",u."Email" AS "CandidateEmail"
       FROM "ExamSubmissions" es
       JOIN "Users" u ON es."CandidateId" = u."Id"
       WHERE es."Id" = $1`,
      [submissionId],
    );

    res.json({ success: true, data: fmtSubmission(full.rows[0]) });
  } catch (err) {
    console.error("Lỗi submitExam:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════════════
   6. Giám thị yêu cầu nộp bài ngay
      POST /api/exam-sessions/:sessionCode/force-submit
════════════════════════════════════════════════════════════ */
exports.forceSubmit = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const { submissionId } = req.body;
    const userId = req.user.id || req.user.Id;

    // Xác nhận giám thị là chủ phiên
    const sr = await pool.query(
      `SELECT "Id" FROM "ExamSessions"
       WHERE "SessionCode" = $1 AND "CreatedBy" = $2 AND "IsActive" = TRUE`,
      [sessionCode, userId],
    );
    if (sr.rowCount === 0) {
      return res.status(403).json({
        success: false,
        message: "Không có quyền thực hiện hành động này",
      });
    }

    await pool.query(
      `UPDATE "ExamSubmissions" SET "ForceSubmit"=TRUE
       WHERE "Id"=$1 AND "Status"='active'`,
      [submissionId],
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Lỗi forceSubmit:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════════════
   7. Kết thúc & xóa phiên thi
      DELETE /api/exam-sessions/:sessionCode
════════════════════════════════════════════════════════════ */
exports.endSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const userId = req.user.id || req.user.Id;

    const sr = await pool.query(
      `SELECT "Id" FROM "ExamSessions"
       WHERE "SessionCode" = $1 AND "CreatedBy" = $2`,
      [sessionCode, userId],
    );
    if (sr.rowCount === 0) {
      return res
        .status(403)
        .json({ success: false, message: "Không có quyền xóa phiên thi này" });
    }

    const sessionId = sr.rows[0].Id;

    // Xóa cascade: submissions trước, session sau
    await pool.query(`DELETE FROM "ExamSubmissions" WHERE "SessionId" = $1`, [
      sessionId,
    ]);
    await pool.query(`DELETE FROM "ExamSessions" WHERE "Id" = $1`, [sessionId]);

    res.json({ success: true });
  } catch (err) {
    console.error("Lỗi endSession:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};
