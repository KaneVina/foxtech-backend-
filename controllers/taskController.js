const { pool } = require("../config/db");
const {
  createNotifications,
  getGroupMemberIds,
} = require("../utils/notificationHelper");

// ── Email service (fire-and-forget, không block response) ──
const emailService = require("../utils/emailService");

// ══════════════════════════════════════════════════════════════════════════════
// DB MIGRATION (chạy 1 lần khi deploy):
//   ALTER TABLE "Tasks"
//     ADD COLUMN IF NOT EXISTS "AttendanceReportUrl" TEXT;
// ══════════════════════════════════════════════════════════════════════════════

// ── Helper dùng chung: kiểm tra user có trong nhóm không ──────────────────────
async function checkMembership(groupId, userId) {
  const result = await pool.query(
    `SELECT 1 FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
    [groupId, userId]
  );
  return result.rows.length > 0;
}

// ── Helper: kiểm tra user có phải Leader hoặc Action Leader trong nhóm không ──
async function checkLeaderRole(groupId, userId) {
  const result = await pool.query(
    `SELECT 1 FROM "GroupMembers"
     WHERE "GroupId" = $1 AND "UserId" = $2
       AND "GroupRole" IN ('Leader','Action Leader')`,
    [groupId, userId]
  );
  return result.rows.length > 0;
}

// [GET] 1. Lấy danh sách Task của một nhóm
exports.getGroupTasks = async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const userId = parseInt(req.user.id || req.user.Id || req.userId);

    if (!(await checkMembership(groupId, userId))) {
      return res.status(403).json({
        success: false,
        message: "Bạn không phải thành viên nhóm này!",
      });
    }

    const result = await pool.query(
      `SELECT t.*, u."Name" AS "CreatorName"
       FROM "Tasks" t
       LEFT JOIN "Users" u ON t."CreatedBy" = u."Id"
       WHERE t."GroupId" = $1
       ORDER BY t."IsPinned" DESC, t."CreatedAt" DESC`,
      [groupId]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi lấy danh sách task:", err);
    res.status(500).json({ success: false, message: "Lỗi server khi lấy Task" });
  }
};

// ─── Helper: Tự sinh TaskCode duy nhất theo GroupId ──────────────────────────
async function generateTaskCode(client, groupId) {
  const groupRes = await client.query(
    `SELECT "SubjectCode", "GroupNumber" FROM "Groups" WHERE "Id" = $1`,
    [groupId]
  );
  const group = groupRes.rows[0];

  const rawSubjectCode = group?.SubjectCode || "TASK";
  const subjectCode = rawSubjectCode
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .substring(0, 3);

  const groupNumber = group?.GroupNumber || 1;
  const prefix = `${subjectCode}${groupNumber}`;

  for (let attempt = 1; attempt <= 200; attempt++) {
    const countRes = await client.query(
      `SELECT COUNT(*) AS cnt FROM "Tasks" WHERE "GroupId" = $1`,
      [groupId]
    );
    const nextNum = parseInt(countRes.rows[0].cnt) + attempt;
    const candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;

    const checkRes = await client.query(
      `SELECT 1 FROM "Tasks" WHERE "TaskCode" = $1`,
      [candidate]
    );
    if (checkRes.rows.length === 0) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

// [POST] 2. TẠO NHIỆM VỤ MỚI
exports.createTask = async (req, res) => {
  const client = await pool.connect();
  try {
    const groupId = parseInt(
      req.params.groupId || req.body.groupId || req.body.GroupId
    );
    const currentUserId = parseInt(req.user.id || req.user.Id || req.userId);

    if (!(await checkMembership(groupId, currentUserId))) {
      return res.status(403).json({
        success: false,
        message: "Bạn không phải thành viên nhóm này!",
      });
    }

    // [GUARD] Chỉ leader / action leader mới được tạo task
    if (!(await checkLeaderRole(groupId, currentUserId))) {
      return res.status(403).json({
        success: false,
        message: "Chỉ Trưởng nhóm hoặc Phó nhóm mới được tạo nhiệm vụ!",
      });
    }

    await client.query("BEGIN");

    const taskCode =
      req.body.TaskCode ||
      req.body.taskCode ||
      (await generateTaskCode(client, groupId));
    const content              = req.body.Content || req.body.content;
    const subject              = req.body.Subject || req.body.subject;
    const taskType             = req.body.TaskType || req.body.taskType;
    const status               = req.body.Status || req.body.status || "not_started";
    const deadline             = req.body.Deadline || req.body.deadline || null;
    const eventDate            = req.body.EventDate || req.body.eventDate || null;
    const isOnline             = req.body.IsOnline ? true : false;
    const canvaLink            = req.body.CanvaLink || null;
    const meetLink             = req.body.MeetLink || null;
    const isImportant          = req.body.IsImportant ? true : false;
    const isPinned             = req.body.IsPinned ? true : false;
    const description          = req.body.Description || null;
    // [NEW] Link báo cáo điểm danh (chỉ dùng cho Hội họp)
    const attendanceReportUrl  = req.body.AttendanceReportUrl || null;

    const result = await client.query(
      `INSERT INTO "Tasks"
         ("GroupId","Content","Subject","TaskType","Status","Deadline","EventDate",
          "CreatedBy","TaskCode","IsOnline","CanvaLink","MeetLink","IsPinned",
          "Description","IsImportant","AttendanceReportUrl","CreatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       RETURNING "Id"`,
      [
        groupId, content, subject, taskType, status, deadline, eventDate,
        currentUserId, taskCode, isOnline, canvaLink, meetLink, isPinned,
        description, isImportant, attendanceReportUrl,
      ]
    );
    const taskId = result.rows[0].Id;

    // Xử lý Giao việc (Assignments)
    const assignments = req.body.Assignments || req.body.assignments;
    const assignedUserIds = [];
    if (assignments && assignments.length > 0) {
      for (const a of assignments) {
        const aUserId = parseInt(a.UserId || a.userId);
        if (aUserId) {
          assignedUserIds.push(aUserId);
          await client.query(
            `INSERT INTO "TaskAssignments" ("TaskId","UserId","Note","Viewed","Completed")
             VALUES ($1,$2,$3,false,false)`,
            [taskId, aUserId, a.Note || a.note || ""]
          );
        }
      }
    }

    // Xử lý Bình chọn
    if (taskType === "Bình chọn") {
      const { PollSettings, PollOptions } = req.body;
      await client.query(
        `INSERT INTO "PollSettings"
           ("TaskId","AllowMultiple","AllowAddOption","HideResultUntilVote","IsAnonymous")
         VALUES ($1,$2,$3,$4,$5)`,
        [
          taskId,
          PollSettings?.AllowMultiple ? true : false,
          PollSettings?.AllowAddOption ? true : false,
          PollSettings?.HideResultUntilVote ? true : false,
          PollSettings?.IsAnonymous ? true : false,
        ]
      );
      if (PollOptions && PollOptions.length > 0) {
        for (const opt of PollOptions) {
          await client.query(
            `INSERT INTO "PollOptions" ("TaskId","OptionText","CreatedBy") VALUES ($1,$2,$3)`,
            [taskId, opt, currentUserId]
          );
        }
      }
    }

    await client.query("COMMIT");

    // ═══════════════════════════════════════════════════════
    // 🔔 NOTIFICATION TRIGGERS (sau commit, không ảnh hưởng response)
    // ═══════════════════════════════════════════════════════
    try {
      const groupRes = await pool.query(
        `SELECT "Name" FROM "Groups" WHERE "Id" = $1`, [groupId]
      );
      const groupName = groupRes.rows[0]?.Name || "Nhóm";

      const creatorRes = await pool.query(
        `SELECT "Name" FROM "Users" WHERE "Id" = $1`, [currentUserId]
      );
      const creatorName = creatorRes.rows[0]?.Name || "Ai đó";

      let assigneeName = null;
      if (assignedUserIds.length > 0) {
        const assigneeRes = await pool.query(
          `SELECT "Name" FROM "Users" WHERE "Id" = $1`, [assignedUserIds[0]]
        );
        assigneeName = assigneeRes.rows[0]?.Name || null;
        if (assignedUserIds.length > 1) {
          assigneeName += ` và ${assignedUserIds.length - 1} người khác`;
        }
      }

      if (req.body.sendNotification !== false) {
        const memberIds = await getGroupMemberIds(groupId);
        await createNotifications({
          userIds: memberIds,
          title: "Nhiệm vụ mới được tạo",
          message: `<strong>${creatorName}</strong> vừa tạo nhiệm vụ: <strong>${content}</strong> trong nhóm <strong>${groupName}</strong>.`,
          type: "task", category: "task", groupId,
          senderId: currentUserId, referenceId: taskId, skipSelf: true,
        });

        if (assignedUserIds.length > 0) {
          await createNotifications({
            userIds: assignedUserIds,
            title: "Bạn được giao nhiệm vụ",
            message: `Bạn được giao nhiệm vụ: <strong>${content}</strong> trong nhóm <strong>${groupName}</strong>.`,
            type: "task", category: "task", groupId,
            senderId: currentUserId, referenceId: taskId, skipSelf: true,
          });
        }
      }

      if (req.body.sendEmail !== false) {
     emailService
  .sendTaskCreatedEmail({
    groupId, groupName, taskTitle: content, taskCode,
    deadline, creatorName, assigneeName,
    taskUrl: `${process.env.FRONTEND_URL}/group/${groupId}`,
  })
          .catch((e) => console.error("[createTask] Email error:", e.message));
      }
    } catch (notifErr) {
      console.error("[createTask] Lỗi notification:", notifErr.message);
    }

    res.status(201).json({
      success: true,
      message: "Tạo nhiệm vụ thành công!",
      data: { taskId, taskCode },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Lỗi tạo task:", err);
    res.status(500).json({ success: false, message: "Lỗi server khi tạo Task" });
  } finally {
    client.release();
  }
};

// [PUT] 3. CẬP NHẬT NHIỆM VỤ
exports.updateTask = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const taskId              = parseInt(req.params.taskId);
    const content             = req.body.Content || req.body.content;
    const subject             = req.body.Subject || req.body.subject;
    const taskType            = req.body.TaskType || req.body.taskType;
    const status              = req.body.Status || req.body.status;
    const deadline            = req.body.Deadline || req.body.deadline || null;
    const eventDate           = req.body.EventDate || req.body.eventDate || null;
    const isOnline            = req.body.IsOnline ? true : false;
    const canvaLink           = req.body.CanvaLink || null;
    const meetLink            = req.body.MeetLink || null;
    const isImportant         = req.body.IsImportant ? true : false;
    const isPinned            = req.body.IsPinned ? true : false;
    const description         = req.body.Description || null;
    // [NEW] Cho phép cập nhật link báo cáo điểm danh qua updateTask (hoặc endpoint riêng)
    const attendanceReportUrl = req.body.AttendanceReportUrl !== undefined
      ? (req.body.AttendanceReportUrl || null)
      : undefined; // undefined = không thay đổi cột này

    const taskRes = await client.query(
      `SELECT "GroupId","Content" FROM "Tasks" WHERE "Id" = $1`, [taskId]
    );
    if (taskRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Task không tồn tại" });
    }

    const gId = taskRes.rows[0].GroupId;
    const tContent = content || taskRes.rows[0].Content;
    const updUserId = parseInt(req.user.id || req.user.Id || req.userId);

    const memberCheck = await client.query(
      `SELECT 1 FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [gId, updUserId]
    );
    if (memberCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Bạn không có quyền chỉnh sửa nhiệm vụ này!",
      });
    }

    // [GUARD] Chỉ leader / action leader mới được sửa task
    if (!(await checkLeaderRole(gId, updUserId))) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Chỉ Trưởng nhóm hoặc Phó nhóm mới được chỉnh sửa nhiệm vụ!",
      });
    }

    // Xây động câu UPDATE (bao gồm AttendanceReportUrl nếu có gửi lên)
    if (attendanceReportUrl !== undefined) {
      await client.query(
        `UPDATE "Tasks" SET
           "Content"=$1,"Subject"=$2,"TaskType"=$3,"Status"=$4,"Deadline"=$5,
           "EventDate"=$6,"IsOnline"=$7,"CanvaLink"=$8,"MeetLink"=$9,
           "IsImportant"=$10,"IsPinned"=$11,"Description"=$12,
           "AttendanceReportUrl"=$13
         WHERE "Id"=$14`,
        [
          content, subject, taskType, status, deadline, eventDate, isOnline,
          canvaLink, meetLink, isImportant, isPinned, description,
          attendanceReportUrl, taskId,
        ]
      );
    } else {
      await client.query(
        `UPDATE "Tasks" SET
           "Content"=$1,"Subject"=$2,"TaskType"=$3,"Status"=$4,"Deadline"=$5,
           "EventDate"=$6,"IsOnline"=$7,"CanvaLink"=$8,"MeetLink"=$9,
           "IsImportant"=$10,"IsPinned"=$11,"Description"=$12
         WHERE "Id"=$13`,
        [
          content, subject, taskType, status, deadline, eventDate, isOnline,
          canvaLink, meetLink, isImportant, isPinned, description, taskId,
        ]
      );
    }

    // Cập nhật assignments nếu có
    const assignments = req.body.Assignments || req.body.assignments;
    let newAssignedIds = [];
    if (assignments !== undefined) {
      await client.query(
        `DELETE FROM "TaskAssignments" WHERE "TaskId" = $1`, [taskId]
      );
      if (assignments && assignments.length > 0) {
        for (const a of assignments) {
          const aUserId = parseInt(a.UserId || a.userId);
          if (aUserId) {
            newAssignedIds.push(aUserId);
            await client.query(
              `INSERT INTO "TaskAssignments" ("TaskId","UserId","Note","Viewed","Completed")
               VALUES ($1,$2,$3,false,false)`,
              [taskId, aUserId, a.Note || a.note || ""]
            );
          }
        }
      }
    }

    await client.query("COMMIT");

    // Notification sau commit
    try {
      const groupRes = await pool.query(
        `SELECT "Name" FROM "Groups" WHERE "Id" = $1`, [gId]
      );
      const groupName = groupRes.rows[0]?.Name || "Nhóm";

      if (newAssignedIds.length > 0) {
        await createNotifications({
          userIds: newAssignedIds,
          title: "Nhiệm vụ được cập nhật",
          message: `Bạn được giao / cập nhật nhiệm vụ: <strong>${tContent}</strong> trong nhóm <strong>${groupName}</strong>.`,
          type: "task", category: "task", groupId: gId,
          senderId: updUserId, referenceId: taskId, skipSelf: true,
        });
      }
    } catch (notifErr) {
      console.error("[updateTask] Lỗi notification:", notifErr.message);
    }

    res.status(200).json({ success: true, message: "Cập nhật thành công!" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Lỗi cập nhật task:", err);
    res.status(500).json({ success: false, message: "Lỗi server khi cập nhật Task" });
  } finally {
    client.release();
  }
};

// [PUT] Đánh dấu đã nhận việc (Viewed)
exports.markViewed = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const userId = parseInt(req.user.id || req.user.Id || req.userId);
    await pool.query(
      `UPDATE "TaskAssignments" SET "Viewed" = true
       WHERE "TaskId" = $1 AND "UserId" = $2`,
      [taskId, userId]
    );
    res.status(200).json({ success: true, message: "Đã xác nhận xem nhiệm vụ" });
  } catch (err) {
    console.error("Lỗi markViewed:", err);
    res.status(500).json({ success: false, message: "Lỗi server khi đánh dấu xem" });
  }
};

// [PUT] Đánh dấu hoàn thành nhiệm vụ
exports.markCompleted = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const userId = parseInt(req.user.id || req.user.Id || req.userId);
    await pool.query(
      `UPDATE "TaskAssignments" SET "Completed" = true
       WHERE "TaskId" = $1 AND "UserId" = $2`,
      [taskId, userId]
    );
    res.status(200).json({ success: true, message: "Đã đánh dấu hoàn thành nhiệm vụ" });
  } catch (err) {
    console.error("Lỗi markCompleted:", err);
    res.status(500).json({ success: false, message: "Lỗi server khi đánh dấu hoàn thành" });
  }
};

// Hàm assignTask
exports.assignTask = async (req, res) => {
  res.status(200).json({ success: true, message: "Tính năng đang được cập nhật" });
};

// ─────────────────────────────────────────────────────────────────────────────
// [GET] Lấy tất cả task của cá nhân
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyAllTasks = async (req, res) => {
  try {
    const userId = parseInt(req.user.id || req.user.Id || req.userId);
    const result = await pool.query(
      `SELECT DISTINCT
         t.*,
         g."Name"        AS "GroupName",
         g."SubjectCode" AS "GroupSubjectCode"
       FROM "Tasks" t
       JOIN "Groups" g        ON t."GroupId"  = g."Id"
       JOIN "GroupMembers" gm ON g."Id"        = gm."GroupId"
       WHERE gm."UserId" = $1
       ORDER BY t."Deadline" ASC`,
      [userId]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi lấy tất cả task:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// [POST] Thêm Option mới
exports.addPollOption = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { optionText } = req.body;
    const userId = parseInt(req.user.id || req.user.Id || req.userId);

    const taskRes = await pool.query(
      `SELECT "GroupId" FROM "Tasks" WHERE "Id" = $1`, [taskId]
    );
    if (taskRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Task không tồn tại" });
    }
    if (!(await checkMembership(taskRes.rows[0].GroupId, userId))) {
      return res.status(403).json({ success: false, message: "Bạn không có quyền thêm lựa chọn!" });
    }

    await pool.query(
      `INSERT INTO "PollOptions" ("TaskId","OptionText","CreatedBy") VALUES ($1,$2,$3)`,
      [taskId, optionText, userId]
    );
    res.json({ success: true, message: "Đã thêm lựa chọn" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Lỗi thêm lựa chọn" });
  }
};

// [PUT] Khóa bình chọn
exports.closePoll = async (req, res) => {
  try {
    const { taskId } = req.params;
    const userId = parseInt(req.user.id || req.user.Id || req.userId);

    const taskRes = await pool.query(
      `SELECT "GroupId","CreatedBy" FROM "Tasks" WHERE "Id" = $1`, [taskId]
    );
    if (taskRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Task không tồn tại" });
    }
    const { GroupId, CreatedBy } = taskRes.rows[0];

    if (!(await checkMembership(GroupId, userId))) {
      return res.status(403).json({
        success: false,
        message: "Bạn không phải thành viên nhóm này!",
      });
    }

    const isCreator = CreatedBy === userId;
    const leaderCheck = await pool.query(
      `SELECT 1 FROM "GroupMembers"
       WHERE "GroupId" = $1 AND "UserId" = $2 AND "GroupRole" IN ('Leader','Action Leader')`,
      [GroupId, userId]
    );
    if (!isCreator && leaderCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Chỉ người tạo hoặc Leader mới được khóa bình chọn!",
      });
    }

    await pool.query(
      `UPDATE "Tasks" SET "Status" = 'completed' WHERE "Id" = $1`, [taskId]
    );
    res.json({ success: true, message: "Đã khóa bình chọn" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Lỗi khóa bình chọn" });
  }
};

// [GET] CHI TIẾT NHIỆM VỤ
exports.getTaskDetail = async (req, res) => {
  try {
    const { taskId } = req.params;
    const currentUserId = parseInt(req.user.id || req.user.Id || req.userId);

    const taskResult = await pool.query(
      `SELECT t.*, g."SubjectCode" AS "GroupSubjectCode", g."Name" AS "GroupName"
       FROM "Tasks" t
       LEFT JOIN "Groups" g ON t."GroupId" = g."Id"
       WHERE t."Id" = $1`,
      [taskId]
    );
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy" });
    }

    let taskDetail = taskResult.rows[0];

    if (!(await checkMembership(taskDetail.GroupId, currentUserId))) {
      return res.status(403).json({ message: "Bạn không có quyền xem nhiệm vụ này!" });
    }

    if (taskDetail.TaskType === "Dự án") {
      const groupMembers = await pool.query(
        `SELECT gm."UserId", u."Name", u."AvatarUrl", u."MemberCode"
         FROM "GroupMembers" gm
         JOIN "Users" u ON gm."UserId" = u."Id"
         WHERE gm."GroupId" = $1`,
        [taskDetail.GroupId]
      );
      taskDetail.Assignees   = groupMembers.rows;
      taskDetail.assignments = groupMembers.rows;
    } else {
      const assignees = await pool.query(
        `SELECT ta.*, u."Name", u."AvatarUrl"
         FROM "TaskAssignments" ta
         JOIN "Users" u ON ta."UserId" = u."Id"
         WHERE ta."TaskId" = $1`,
        [taskId]
      );
      taskDetail.Assignees   = assignees.rows;
      taskDetail.assignments = assignees.rows;
    }

    if (taskDetail.TaskType === "Bình chọn") {
      const settingsResult = await pool.query(
        `SELECT * FROM "PollSettings" WHERE "TaskId" = $1`, [taskId]
      );
      taskDetail.PollSettings = settingsResult.rows[0] || {};

      const optionsResult = await pool.query(
        `SELECT po."Id", po."OptionText", po."CreatedBy"
         FROM "PollOptions" po WHERE po."TaskId" = $1`,
        [taskId]
      );
      taskDetail.PollOptions = optionsResult.rows;

      const votesResult = await pool.query(
        `SELECT pv."OptionId", u."Name" AS "UserName", u."Id" AS "UserId"
         FROM "PollVotes" pv
         JOIN "Users" u ON pv."UserId" = u."Id"
         JOIN "PollOptions" po ON pv."OptionId" = po."Id"
         WHERE po."TaskId" = $1`,
        [taskId]
      );
      taskDetail.Votes = votesResult.rows;
    }

    res.json({ success: true, data: taskDetail });
  } catch (err) {
    console.error("Lỗi getTaskDetail:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// [PUT] Ghim / Bỏ ghim Nhiệm vụ
exports.togglePinTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { isPinned } = req.body;
    const userId = parseInt(req.user.id || req.user.Id || req.userId);

    const taskRes = await pool.query(
      `SELECT "GroupId" FROM "Tasks" WHERE "Id" = $1`, [taskId]
    );
    if (taskRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Task không tồn tại" });
    }
    if (!(await checkMembership(taskRes.rows[0].GroupId, userId))) {
      return res.status(403).json({
        success: false,
        message: "Bạn không có quyền ghim nhiệm vụ này!",
      });
    }

    await pool.query(
      `UPDATE "Tasks" SET "IsPinned" = $1 WHERE "Id" = $2`,
      [isPinned ? true : false, taskId]
    );
    res.json({
      success: true,
      message: isPinned ? "Đã ghim nhiệm vụ" : "Đã bỏ ghim",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Lỗi khi ghim" });
  }
};

// [POST] Gửi lượt bình chọn
exports.votePoll = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { optionIds } = req.body;
    const userId = parseInt(req.user.id || req.user.Id || req.userId);

    const taskRes = await pool.query(
      `SELECT "GroupId" FROM "Tasks" WHERE "Id" = $1`, [taskId]
    );
    if (taskRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Task không tồn tại" });
    }
    if (!(await checkMembership(taskRes.rows[0].GroupId, userId))) {
      return res.status(403).json({ success: false, message: "Bạn không có quyền bình chọn!" });
    }

    const optionsRes = await pool.query(
      `SELECT "Id" FROM "PollOptions" WHERE "TaskId" = $1`, [taskId]
    );
    const optionIdsOfTask = optionsRes.rows.map((o) => o.Id);

    if (optionIdsOfTask.length > 0) {
      for (const optId of optionIdsOfTask) {
        await pool.query(
          `DELETE FROM "PollVotes" WHERE "UserId" = $1 AND "OptionId" = $2`,
          [userId, optId]
        );
      }
    }

    for (const optId of optionIds) {
      await pool.query(
        `INSERT INTO "PollVotes" ("OptionId","UserId") VALUES ($1,$2)`,
        [optId, userId]
      );
    }
    res.json({ success: true, message: "Đã ghi nhận bình chọn" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// [POST] /:taskId/remind — Gửi nhắc nhở cho tất cả thành viên chưa hoàn thành
// Chỉ leader / action leader mới được gọi
// ══════════════════════════════════════════════════════════════════════════════
exports.remindTask = async (req, res) => {
  try {
    const taskId  = parseInt(req.params.taskId);
    const userId  = parseInt(req.user.id || req.user.Id || req.userId);

    // 1. Lấy thông tin task
    const taskRes = await pool.query(
      `SELECT t."GroupId", t."Content", t."Deadline", t."TaskCode"
       FROM "Tasks" t WHERE t."Id" = $1`,
      [taskId]
    );
    if (taskRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Task không tồn tại" });
    }
    const { GroupId, Content, Deadline, TaskCode } = taskRes.rows[0];

    // 2. Kiểm tra membership
    if (!(await checkMembership(GroupId, userId))) {
      return res.status(403).json({ success: false, message: "Bạn không phải thành viên nhóm này!" });
    }

    // 3. Kiểm tra quyền leader
    if (!(await checkLeaderRole(GroupId, userId))) {
      return res.status(403).json({
        success: false,
        message: "Chỉ Trưởng nhóm hoặc Phó nhóm mới được gửi nhắc nhở!",
      });
    }

    // 4. Lấy danh sách thành viên chưa hoàn thành (ưu tiên assignees, fallback toàn nhóm)
    const assigneeRes = await pool.query(
      `SELECT ta."UserId"
       FROM "TaskAssignments" ta
       WHERE ta."TaskId" = $1 AND ta."Completed" = false`,
      [taskId]
    );

    let targetUserIds = assigneeRes.rows.map((r) => r.UserId);

    // Nếu task không có assignee → nhắc toàn bộ nhóm
    if (targetUserIds.length === 0) {
      targetUserIds = await getGroupMemberIds(GroupId);
    }

    if (targetUserIds.length === 0) {
      return res.json({ success: true, message: "Không có ai cần nhắc nhở." });
    }

    // 5. Lấy tên người gửi & nhóm
    const senderRes = await pool.query(
      `SELECT "Name" FROM "Users" WHERE "Id" = $1`, [userId]
    );
    const senderName = senderRes.rows[0]?.Name || "Trưởng nhóm";

    const groupRes = await pool.query(
      `SELECT "Name" FROM "Groups" WHERE "Id" = $1`, [GroupId]
    );
    const groupName = groupRes.rows[0]?.Name || "Nhóm";

    const deadlineStr = Deadline
      ? new Date(Deadline).toLocaleString("vi-VN")
      : "không có thời hạn";

    // 6. Tạo notifications
    await createNotifications({
      userIds: targetUserIds,
      title: "⏰ Nhắc nhở nhiệm vụ",
      message: `<strong>${senderName}</strong> nhắc nhở bạn hoàn thành nhiệm vụ: <strong>${Content}</strong> (Hạn: ${deadlineStr}) trong nhóm <strong>${groupName}</strong>.`,
      type: "reminder",
      category: "task",
      groupId: GroupId,
      senderId: userId,
      referenceId: taskId,
      skipSelf: true,
    });

    // 7. (Tuỳ chọn) Gửi email nhắc nhở nếu emailService hỗ trợ
    try {
      if (typeof emailService.sendTaskReminderEmail === "function") {
        emailService
          .sendTaskReminderEmail({
            groupId: GroupId, groupName,
            taskContent: Content, taskCode: TaskCode,
            deadline: Deadline, senderName,
            recipientUserIds: targetUserIds,
          })
          .catch((e) => console.error("[remindTask] Email error:", e.message));
      }
    } catch (_) {}

    res.json({
      success: true,
      message: `Đã gửi nhắc nhở đến ${targetUserIds.length} thành viên.`,
      count: targetUserIds.length,
    });
  } catch (err) {
    console.error("Lỗi remindTask:", err);
    res.status(500).json({ success: false, message: "Lỗi server khi gửi nhắc nhở" });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// [PUT] /:taskId/attendance-report — Leader/Action leader lưu URL báo cáo điểm danh
// ══════════════════════════════════════════════════════════════════════════════
exports.updateAttendanceReport = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const userId = parseInt(req.user.id || req.user.Id || req.userId);
    const { attendanceReportUrl } = req.body;

    const taskRes = await pool.query(
      `SELECT "GroupId","TaskType" FROM "Tasks" WHERE "Id" = $1`, [taskId]
    );
    if (taskRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Task không tồn tại" });
    }
    const { GroupId, TaskType } = taskRes.rows[0];

    if (TaskType !== "Hội họp") {
      return res.status(400).json({ success: false, message: "Chỉ task Hội họp mới có báo cáo điểm danh" });
    }
    if (!(await checkMembership(GroupId, userId))) {
      return res.status(403).json({ success: false, message: "Bạn không phải thành viên nhóm này!" });
    }
    if (!(await checkLeaderRole(GroupId, userId))) {
      return res.status(403).json({ success: false, message: "Chỉ Trưởng nhóm hoặc Phó nhóm mới được cập nhật báo cáo!" });
    }

    await pool.query(
      `UPDATE "Tasks" SET "AttendanceReportUrl" = $1 WHERE "Id" = $2`,
      [attendanceReportUrl || null, taskId]
    );

    res.json({ success: true, message: "Đã lưu link báo cáo điểm danh." });
  } catch (err) {
    console.error("Lỗi updateAttendanceReport:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};


// ══════════════════════════════════════════════════════════════════════════════
// [GET] /:taskId/meeting-attendances
// Lấy kết quả điểm danh của task + tổng kết toàn nhóm
// ══════════════════════════════════════════════════════════════════════════════
exports.getMeetingAttendances = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const userId = parseInt(req.user.id || req.user.Id || req.userId);

    const taskRes = await pool.query(
      `SELECT "GroupId","TaskType","MeetingCheckedOut" FROM "Tasks" WHERE "Id" = $1`,
      [taskId]
    );
    if (taskRes.rows.length === 0)
      return res.status(404).json({ success: false, message: "Task không tồn tại" });

    const { GroupId, TaskType, MeetingCheckedOut } = taskRes.rows[0];

    if (TaskType !== "Hội họp")
      return res.status(400).json({ success: false, message: "Chỉ task Hội họp mới có bảng điểm danh" });
    if (!(await checkMembership(GroupId, userId)))
      return res.status(403).json({ success: false, message: "Bạn không phải thành viên nhóm này!" });
    if (!MeetingCheckedOut)
      return res.json({ success: true, data: { checkedOut: false, rows: [], groupStats: [] } });

    // Kết quả cuộc họp này
    const thisRes = await pool.query(
      `SELECT ma."UserId", ma."ParticipantName", ma."AttendedPercentage",
              u."Name", u."AvatarUrl"
       FROM "MeetingAttendances" ma
       LEFT JOIN "Users" u ON ma."UserId" = u."Id"
       WHERE ma."TaskId" = $1
       ORDER BY ma."AttendedPercentage" DESC`,
      [taskId]
    );

    // Tổng kết toàn nhóm: trung bình % mỗi thành viên qua tất cả cuộc họp đã checkout
    const groupRes = await pool.query(
      `SELECT
         ma."UserId",
         u."Name",
         u."AvatarUrl",
         ROUND(AVG(ma."AttendedPercentage")::numeric, 1) AS "AvgPercentage",
         COUNT(DISTINCT ma."TaskId")::int                AS "AttendedMeetings",
         (SELECT COUNT(*) FROM "Tasks"
          WHERE "GroupId" = $1
            AND "TaskType" = 'Hội họp'
            AND "MeetingCheckedOut" = TRUE)::int         AS "TotalMeetings"
       FROM "MeetingAttendances" ma
       JOIN "Tasks" t ON ma."TaskId" = t."Id"
       LEFT JOIN "Users" u ON ma."UserId" = u."Id"
       WHERE t."GroupId" = $1
         AND t."MeetingCheckedOut" = TRUE
       GROUP BY ma."UserId", u."Name", u."AvatarUrl"
       ORDER BY "AvgPercentage" DESC`,
      [GroupId]
    );

    res.json({
      success: true,
      data: {
        checkedOut: true,
          meetingMeta: null,
        rows: thisRes.rows,          // điểm danh cuộc họp này
        groupStats: groupRes.rows,   // tổng kết toàn nhóm
      },
    });
  } catch (err) {
    console.error("Lỗi getMeetingAttendances:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};
// ══════════════════════════════════════════════════════════════════════════════
// [POST] /:taskId/attendance-csv — Upload CSV điểm danh + checkout
// ══════════════════════════════════════════════════════════════════════════════
exports.uploadAttendanceCsv = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const userId = parseInt(req.user.id || req.user.Id || req.userId);

    const taskRes = await pool.query(
      `SELECT "GroupId","TaskType","MeetingCheckedOut" FROM "Tasks" WHERE "Id" = $1`,
      [taskId]
    );
    if (taskRes.rows.length === 0)
      return res.status(404).json({ success: false, message: "Task không tồn tại" });

    const { GroupId, TaskType, MeetingCheckedOut } = taskRes.rows[0];

    if (TaskType !== "Hội họp")
      return res.status(400).json({ success: false, message: "Chỉ task Hội họp mới có điểm danh" });
    if (!(await checkMembership(GroupId, userId)))
      return res.status(403).json({ success: false, message: "Bạn không phải thành viên nhóm này!" });
    if (!(await checkLeaderRole(GroupId, userId)))
      return res.status(403).json({ success: false, message: "Chỉ Trưởng nhóm hoặc Phó nhóm mới được checkout!" });
    // if (MeetingCheckedOut)
    //   return res.status(400).json({ success: false, message: "Cuộc họp này đã được checkout, không thể thay đổi!" });

    // Parse mappings từ body
    let mappings = [];
    try {
      mappings = JSON.parse(req.body.mappings || "[]");
    } catch (_) {}

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Xóa dữ liệu cũ nếu có
      await client.query(`DELETE FROM "MeetingAttendances" WHERE "TaskId" = $1`, [taskId]);

      // Insert từng dòng
      for (const m of mappings) {
        const { participantName, userId: mappedUserId, attendedPercentage } = m;
        await client.query(
          `INSERT INTO "MeetingAttendances"
             ("TaskId","UserId","ParticipantName","AttendedPercentage")
           VALUES ($1,$2,$3,$4)`,
          [taskId, mappedUserId || null, participantName, attendedPercentage ?? 0]
        );
      }

      // Đánh dấu checkout
      await client.query(
        `UPDATE "Tasks" SET "MeetingCheckedOut" = TRUE WHERE "Id" = $1`,
        [taskId]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, message: "Checkout điểm danh thành công!" });
  } catch (err) {
    console.error("Lỗi uploadAttendanceCsv:", err);
    res.status(500).json({ success: false, message: "Lỗi server khi checkout điểm danh" });
  }
};