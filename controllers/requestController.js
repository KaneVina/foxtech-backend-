const { pool } = require("../config/db");
// [GET] Lấy lịch sử đơn đã gửi (Gộp cả đơn thường và đơn tạo nhóm)
exports.getMyRequests = async (req, res) => {
  try {
    const userId = req.user.id || req.user.Id || req.userId;

    const result = await pool.query(
      `SELECT "Id", "FormType", "Status", "Reason", "CreatedAt", "ResolveNote",
              NULL AS "GroupName", NULL AS "SubjectCode"
       FROM "Requests" WHERE "SenderId" = $1
       UNION ALL
       SELECT "Id", 'group_creation' AS "FormType",
              CASE LOWER("Status")
                WHEN 'pending' THEN 'Pending'
                WHEN 'approved' THEN 'Approved'
                WHEN 'rejected' THEN 'Rejected'
                ELSE "Status"
              END AS "Status",
              "Description" AS "Reason", "CreatedAt",
              "AdminNote" AS "ResolveNote", "GroupName", "SubjectCode"
       FROM "GroupRequests" WHERE "CreatedBy" = $1
       ORDER BY "CreatedAt" DESC`,
      [userId]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Lỗi lấy lịch sử đơn tổng hợp:", err);
    res.status(500).json({ message: "Lỗi server khi lấy lịch sử đơn" });
  }
};

// [POST] Tạo đơn mới
exports.createRequest = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id || req.user.Id || req.userId;
    const { formType, groupId, reason, receivers, taskId, delayOption, substituteId, newDeadline, canvaLink } = req.body;

    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO "Requests" ("SenderId","FormType","GroupId","Reason","TaskId","DelayOption","SubstituteId","NewDeadline","CanvaLink","Status","CreatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pending',NOW()) RETURNING "Id"`,
      [parseInt(userId), formType, groupId ? parseInt(groupId) : null, reason,
       taskId ? parseInt(taskId) : null, delayOption || null,
       substituteId ? parseInt(substituteId) : null, newDeadline || null, canvaLink || null]
    );
    const newRequestId = result.rows[0].Id;

    if (receivers && receivers.length > 0) {
      for (let recId of receivers) {
        await client.query(
          `INSERT INTO "RequestReceivers" ("RequestId","ReceiverId") VALUES ($1,$2)`,
          [newRequestId, parseInt(recId)]
        );
      }
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Đã tạo đơn thành công" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Lỗi tạo đơn:", err);
    res.status(500).json({ message: "Lỗi server khi tạo đơn" });
  } finally {
    client.release();
  }
};

// [GET] Lấy danh sách duyệt
exports.getManageRequests = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT R.*, U."Name" AS "SenderName" FROM "Requests" R
       LEFT JOIN "Users" U ON R."SenderId" = U."Id"
       ORDER BY R."CreatedAt" DESC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Lỗi lấy danh sách duyệt:", err);
    res.status(500).json({ message: "Lỗi server" });
  }
};

// [PUT] Duyệt / Từ chối đơn
exports.resolveRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolveNote } = req.body;
    const resolverId = req.user.id || req.user.Id || req.userId;

    await pool.query(
      `UPDATE "Requests" SET "Status"=$1,"ResolveNote"=$2,"ResolverId"=$3,"ResolvedAt"=NOW() WHERE "Id"=$4`,
      [status, resolveNote, resolverId, id]
    );

    res.status(200).json({ message: "Đã xử lý đơn!" });
  } catch (err) {
    console.error("Lỗi xử lý đơn:", err);
    res.status(500).json({ message: "Lỗi server khi xử lý đơn" });
  }
};
