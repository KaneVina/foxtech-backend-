const { pool } = require("../config/db");
const fetch = require("node-fetch");
const { generateUCID, generateDefectId } = require("../utils/generateId");
const crypto = require("crypto");

// ── Email service (fire-and-forget, không block response) ──
const emailService = require("../utils/emailService");
const { buildGroupUrl, getGroupName } = require("../utils/groupUrl");
const {
  createNotifications,
  getGroupMemberIds,
} = require("../utils/notificationHelper");

function parseSafeDate(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr === "string" && dateStr.length === 10) return dateStr;
  const s =
    typeof dateStr === "string" ? dateStr : new Date(dateStr).toISOString();
  return s.split("T")[0];
}

async function checkAndComplete(scheduleId) {
  // ── Gate 1: Technical issues ──────────────────────────────
  const g1Res = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN "Status" != 'Hoàn thành' THEN 1 ELSE 0 END) AS open
     FROM "IssueTrackings"
     WHERE "ProjectScheduleId" = $1 AND "IssueType" = 'Technical'`,
    [scheduleId],
  );
  const g1 = g1Res.rows[0];
  const gate1 = Number(g1.open) === 0;

  // ── Gate 2: Document issues ───────────────────────────────
  const g2Res = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN "Status" != 'Hoàn thành' THEN 1 ELSE 0 END) AS open
     FROM "IssueTrackings"
     WHERE "ProjectScheduleId" = $1 AND "IssueType" = 'Document'`,
    [scheduleId],
  );
  const g2 = g2Res.rows[0];
  const gate2 = Number(g2.open) === 0;

  // ── Gate 3: SonarQube ─────────────────────────────────────
  const g3Res = await pool.query(
    `SELECT "QualityStatus", "BugCount", "VulnerabilityCount", "DashboardUrl", "CreatedAt"
     FROM "SonarQubeResults"
     WHERE "ScheduleId" = $1
     ORDER BY "CreatedAt" DESC
     LIMIT 1`,
    [scheduleId],
  );
  const sonarRow = g3Res.rows[0] || null;
  const gate3 = sonarRow?.QualityStatus === "OK";

  const allPassed = gate1 && gate2 && gate3;

  if (allPassed) {
    await pool.query(
      `UPDATE "ProjectSchedules"
       SET "Status" = 'Hoàn thành'
       WHERE "Id" = $1 AND "Status" NOT IN ('Hoàn thành', 'Tạm miễn')`,
      [scheduleId],
    );

    try {
      const scRes = await pool.query(
        `SELECT ps."UCID", ps."TaskTitle", ps."OwnerId", ps."TaskId",
                u."Name" AS "OwnerName", t."GroupId"
         FROM "ProjectSchedules" ps
         LEFT JOIN "Users" u ON ps."OwnerId" = u."Id"
         LEFT JOIN "Tasks" t ON ps."TaskId"  = t."Id"
         WHERE ps."Id" = $1`,
        [scheduleId],
      );
      if (scRes.rows.length) {
        const sc = scRes.rows[0];
        const groupName = await getGroupName(sc.GroupId);
const taskUrl = buildGroupUrl(sc.GroupId, groupName);
        emailService.sendUCCompletedEmail({
          groupId: sc.GroupId,
          ucid: sc.UCID,
          ucTitle: sc.TaskTitle,
          ownerName: sc.OwnerName,
          taskUrl,
        });
        const memberIds = await getGroupMemberIds(sc.GroupId);
        createNotifications({
          userIds: memberIds,
          title: `UC Hoàn thành: ${sc.UCID}`,
          message: `<strong>${sc.UCID} — ${sc.TaskTitle}</strong> đã vượt qua tất cả cổng nghiệm thu và chuyển sang <strong>Hoàn thành</strong>.`,
          type: "task",
          category: "task",
          groupId: sc.GroupId,
          senderId: null,
          referenceId: sc.TaskId,
          skipSelf: false,
        });
      }
    } catch (err) {
      console.error("[checkAndComplete] Lỗi email/notif:", err.message);
    }
  }

  return {
    gate1,
    gate2,
    gate3,
    allPassed,
    detail: {
      technicalIssues: g1,
      documentIssues: g2,
      sonarQube: sonarRow,
    },
  };
}

async function fullReset(scheduleId, pushId) {
  await pool.query(
    `UPDATE "UCCodePushes" SET "IsActive" = false WHERE "Id" = $1`,
    [pushId],
  );
  await pool.query(
    `UPDATE "UCDocuments"
     SET "Status" = 'Chưa bắt đầu',
         "ReviewerId" = NULL,
         "ReviewedAt" = NULL,
         "RejectionNote" = NULL,
         "UpdatedAt" = NOW()
     WHERE "ProjectScheduleId" = $1`,
    [scheduleId],
  );
  await pool.query(
    `UPDATE "ProjectSchedules" SET "Status" = 'Chưa bắt đầu' WHERE "Id" = $1`,
    [scheduleId],
  );
}

// ─────────────────────────────────────────────────────────────
// HELPER NỘI BỘ: getReviewerRole
// ─────────────────────────────────────────────────────────────
async function getReviewerRole(req, taskId) {
  const userId = req.user?.id || req.user?.Id;
  const systemRole = (req.user?.role || req.user?.Role || "").toLowerCase();

  const taskRes = await pool.query(
    `SELECT "GroupId" FROM "Tasks" WHERE "Id" = $1`,
    [taskId],
  );
  if (!taskRes.rows.length)
    return { isLeader: false, isAL: false, canReview: false };

  const groupId = taskRes.rows[0].GroupId;
  const roleRes = await pool.query(
    `SELECT "GroupRole" FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
    [groupId, userId],
  );

  const groupRole = roleRes.rows.length
    ? roleRes.rows[0].GroupRole.toLowerCase()
    : "";
  const isLeader = groupRole === "leader" || systemRole === "admin";
  const isAL = groupRole === "action leader";

  return { isLeader, isAL, canReview: isLeader || isAL };
}

exports.getSchedules = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const result = await pool.query(
      `SELECT ps.*, u."Name" AS "OwnerName", u."AvatarUrl" AS "OwnerAvatar",

             (SELECT STRING_AGG("DefectId", ', ')
              FROM "IssueTrackings" WHERE "ProjectScheduleId" = ps."Id") AS "DefectIds",
             (SELECT COUNT(*)
              FROM "IssueTrackings" WHERE "ProjectScheduleId" = ps."Id") AS "TotalDefects",
             (SELECT COUNT(*)
              FROM "IssueTrackings"
              WHERE "ProjectScheduleId" = ps."Id"
                AND "Status" != 'Hoàn thành') AS "IncompleteDefects",

             (SELECT COUNT(*)
              FROM "IssueTrackings"
              WHERE "ProjectScheduleId" = ps."Id"
                AND "IssueType" = 'Technical'
                AND "Status" != 'Hoàn thành') AS "TechnicalOpen",

             (SELECT COUNT(*)
              FROM "IssueTrackings"
              WHERE "ProjectScheduleId" = ps."Id"
                AND "IssueType" = 'Technical') AS "TechnicalTotal",

             (SELECT COUNT(*)
              FROM "IssueTrackings"
              WHERE "ProjectScheduleId" = ps."Id"
                AND "IssueType" = 'Document'
                AND "Status" != 'Hoàn thành') AS "DocumentOpen",

             (SELECT COUNT(*)
              FROM "IssueTrackings"
              WHERE "ProjectScheduleId" = ps."Id"
                AND "IssueType" = 'Document') AS "DocumentTotal",

             (SELECT "QualityStatus"
              FROM "SonarQubeResults"
              WHERE "ScheduleId" = ps."Id"
              ORDER BY "CreatedAt" DESC
              LIMIT 1) AS "SonarStatus",

             (SELECT "Status"
              FROM "UCCodePushes"
              WHERE "ProjectScheduleId" = ps."Id" AND "IsActive" = true
              ORDER BY "CreatedAt" DESC
              LIMIT 1) AS "LatestPushStatus",
             (SELECT "RejectionNote"
              FROM "UCCodePushes"
              WHERE "ProjectScheduleId" = ps."Id" AND "IsActive" = true
              ORDER BY "CreatedAt" DESC
              LIMIT 1) AS "LatestPushRejectionNote",

             (SELECT COUNT(*)
              FROM "UCDocuments" WHERE "ProjectScheduleId" = ps."Id") AS "TotalDocs",
             (SELECT COUNT(*)
              FROM "UCDocuments"
              WHERE "ProjectScheduleId" = ps."Id"
                AND "Status" = 'Đã phê duyệt') AS "ApprovedDocs"

      FROM "ProjectSchedules" ps
      LEFT JOIN "Users" u ON ps."OwnerId" = u."Id"
      WHERE ps."TaskId" = $1
      ORDER BY ps."Id" ASC`,
      [taskId],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("getSchedules:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.createSchedule = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const {
      UCID: customUCID,
      TaskTitle,
      Iteration,
      Complexity,
      Roles,
      OwnerId,
      StartDate,
      DueDate,
      Status,
      Note,
      BusinessRule,
      IsUrgent,
      EditPermission,
      GroupName,
    } = req.body;

    if (!TaskTitle || TaskTitle.trim() === "") {
      return res
        .status(400)
        .json({ success: false, message: "TaskTitle không được để trống!" });
    }

    let ucid;
    if (customUCID && customUCID.trim()) {
      const dup = await pool.query(
        `SELECT "Id" FROM "ProjectSchedules" WHERE "TaskId" = $1 AND "UCID" = $2`,
        [taskId, customUCID.trim()],
      );
      if (dup.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: `UC ID "${customUCID.trim()}" đã tồn tại!`,
        });
      }
      ucid = customUCID.trim();
    } else {
      ucid = await generateUCID(taskId);
    }

    const result = await pool.query(
      `INSERT INTO "ProjectSchedules"
         ("TaskId", "UCID", "TaskTitle", "Iteration", "Complexity", "Roles", "OwnerId",
          "StartDate", "DueDate", "Status", "Note", "BusinessRule", "IsUrgent", "EditPermission", "GroupName")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        taskId,
        ucid,
        TaskTitle.trim(),
        Iteration || "Iter 1",
        Complexity || "Medium",
        Roles ? JSON.stringify(Roles) : null,
        OwnerId || null,
        parseSafeDate(StartDate),
        parseSafeDate(DueDate),
        Status || "Chưa bắt đầu",
        Note || null,
        BusinessRule || null,
        IsUrgent ? true : false,
        EditPermission || "all",
        GroupName || null,
      ],
    );

    const created = result.rows[0];
    const withOwner = await pool.query(
      `SELECT ps.*, u."Name" AS "OwnerName", u."AvatarUrl" AS "OwnerAvatar"
       FROM "ProjectSchedules" ps
       LEFT JOIN "Users" u ON ps."OwnerId" = u."Id"
       WHERE ps."Id" = $1`,
      [created.Id],
    );
    res.status(201).json({ success: true, data: withOwner.rows[0] });
  } catch (err) {
    console.error("createSchedule:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.updateSchedule = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const taskId = parseInt(req.params.taskId);

    const {
      TaskTitle,
      Iteration,
      Complexity,
      Roles,
      OwnerId,
      StartDate,
      DueDate,
      Status,
      Note,
      BusinessRule,
      IsUrgent,
      EditPermission,
      GroupName,
      manualApprove,
    } = req.body;

    const permRes = await pool.query(
      `SELECT "EditPermission" FROM "ProjectSchedules" WHERE "Id" = $1`,
      [scheduleId],
    );
    if (permRes.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy" });
    }
    const perm = permRes.rows[0].EditPermission;

    const taskRes = await pool.query(
      `SELECT "GroupId" FROM "Tasks" WHERE "Id" = $1`,
      [taskId],
    );
    if (taskRes.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Task không tồn tại" });
    }

    const groupId = taskRes.rows[0].GroupId;
    const userId = req.user.id || req.user.Id || req.userId;

    const roleRes = await pool.query(
      `SELECT "GroupRole" FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [groupId, userId],
    );

    const groupRole =
      roleRes.rows.length > 0 ? roleRes.rows[0].GroupRole.toLowerCase() : "";
    const systemRole = (req.user.role || req.user.Role || "").toLowerCase();
    const isLeader = groupRole === "leader" || systemRole === "admin";
    const isAL = groupRole === "action leader";

    if (perm === "leader_only" && !isLeader) {
      return res.status(403).json({
        success: false,
        message: "Chỉ Leader mới có thể chỉnh sửa mục này!",
      });
    }
    if (perm === "action_leader" && !isLeader && !isAL) {
      return res
        .status(403)
        .json({ success: false, message: "Cần quyền Action Leader trở lên!" });
    }

    if (Status === "Hoàn thành") {
      if (manualApprove && isLeader) {
        // Nghiệm thu thủ công – Leader/Admin được phép bỏ qua gate
      } else {
        const gates = await checkAndComplete(scheduleId);
        if (!gates.allPassed) {
          const missing = [];
       if (!gates.gate1) missing.push("vẫn còn lỗi kỹ thuật chưa hoàn thành");
if (!gates.gate2) missing.push("vẫn còn lỗi tài liệu chưa hoàn thành");
if (!gates.gate3) missing.push("SonarQube chưa đạt Quality Gate");
          return res.status(400).json({
            success: false,
            message: `Không thể chuyển sang trạng thái "Hoàn thành": ${missing.join("; ")}. Dùng nút "Duyệt thủ công" hoặc hoàn tất điều kiện nghiệm thu.`,
          });
        }
      }
    }

    const cleanStartDate = parseSafeDate(StartDate);
    const cleanDueDate = parseSafeDate(DueDate);

    let finalStatus = Status;
    if (
      cleanDueDate &&
      finalStatus !== "Tạm miễn" &&
      finalStatus !== "Hoàn thành"
    ) {
      if (
        new Date(cleanDueDate) <
        new Date(new Date().toISOString().split("T")[0])
      ) {
        finalStatus = "Đình chỉ";
      }
    }

    await pool.query(
      `UPDATE "ProjectSchedules" SET
         "TaskTitle"      = $1,
         "Iteration"      = $2,
         "Complexity"     = $3,
         "Roles"          = $4,
         "OwnerId"        = $5,
         "StartDate"      = $6,
         "DueDate"        = $7,
         "Status"         = $8,
         "Note"           = $9,
         "BusinessRule"   = $10,
         "IsUrgent"       = $11,
         "EditPermission" = $12,
         "GroupName"      = $13
       WHERE "Id" = $14`,
      [
        TaskTitle,
        Iteration || "Iter 1",
        Complexity || "Medium",
        Roles ? JSON.stringify(Roles) : null,
        OwnerId || null,
        cleanStartDate,
        cleanDueDate,
        finalStatus,
        Note || null,
        BusinessRule || null,
        IsUrgent ? true : false,
        EditPermission || "all",
        GroupName !== undefined ? GroupName || null : null,
        scheduleId,
      ],
    );

    const updated = await pool.query(
      `SELECT ps.*, u."Name" AS "OwnerName", u."AvatarUrl" AS "OwnerAvatar"
       FROM "ProjectSchedules" ps
       LEFT JOIN "Users" u ON ps."OwnerId" = u."Id"
       WHERE ps."Id" = $1`,
      [scheduleId],
    );
    res.json({ success: true, data: updated.rows[0] });
  } catch (err) {
    console.error("updateSchedule:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.deleteSchedule = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const issueCheck = await pool.query(
      `SELECT COUNT(*) AS cnt FROM "IssueTrackings" WHERE "ProjectScheduleId" = $1`,
      [scheduleId],
    );
    if (parseInt(issueCheck.rows[0].cnt) > 0) {
      return res.status(400).json({
        success: false,
        message: "Không thể xóa: Còn issue đang liên kết với UC này!",
      });
    }
    await pool.query(`DELETE FROM "ProjectSchedules" WHERE "Id" = $1`, [
      scheduleId,
    ]);
    res.json({ success: true, message: "Đã xóa thành công" });
  } catch (err) {
    console.error("deleteSchedule:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.getIssues = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const result = await pool.query(
      `SELECT it.*,
              ps."UCID", ps."TaskTitle" AS "UCTaskTitle", ps."OwnerId" AS "ActionOwnerId",
              uo."Name" AS "ActionOwnerName",
              ud."Name" AS "DetectedByName"
       FROM "IssueTrackings" it
       LEFT JOIN "ProjectSchedules" ps ON it."ProjectScheduleId" = ps."Id"
       LEFT JOIN "Users" uo ON ps."OwnerId" = uo."Id"
       LEFT JOIN "Users" ud ON it."DetectedById" = ud."Id"
       WHERE it."TaskId" = $1
       ORDER BY it."Id" ASC`,
      [taskId],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("getIssues:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.createIssue = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const defectId = await generateDefectId(taskId);
    const {
      ProjectScheduleId,
      IssueType,
      Severity,
      Description,
      DetectedById,
      StartDate,
      DueDate,
      Status,
      EvidenceUrl,
      IsUrgent,
    } = req.body;

    const cleanStart = StartDate ? StartDate.split("T")[0] : null;
    const cleanDue = DueDate ? DueDate.split("T")[0] : null;

    const result = await pool.query(
      `INSERT INTO "IssueTrackings"
         ("TaskId", "DefectId", "ProjectScheduleId", "IssueType", "Severity",
          "Description", "DetectedById", "StartDate", "DueDate", "Status", "EvidenceUrl", "IsUrgent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        taskId,
        defectId,
        ProjectScheduleId || null,
        IssueType || "Technical",
        Severity || "Minor",
        Description || null,
        DetectedById || null,
        cleanStart,
        cleanDue,
        Status || "Chưa bắt đầu",
        EvidenceUrl || null,
        IsUrgent ? true : false,
      ],
    );

    const created = result.rows[0];
    const withJoins = await pool.query(
      `SELECT it.*, ps."UCID", ps."TaskTitle" AS "UCTaskTitle", ps."OwnerId" AS "ActionOwnerId",
              uo."Name" AS "ActionOwnerName", ud."Name" AS "DetectedByName"
       FROM "IssueTrackings" it
       LEFT JOIN "ProjectSchedules" ps ON it."ProjectScheduleId" = ps."Id"
       LEFT JOIN "Users" uo ON ps."OwnerId" = uo."Id"
       LEFT JOIN "Users" ud ON it."DetectedById" = ud."Id"
       WHERE it."Id" = $1`,
      [created.Id],
    );

    if (ProjectScheduleId) {
      await checkAndComplete(parseInt(ProjectScheduleId));
    }

    try {
      if (ProjectScheduleId) {
        const scRes = await pool.query(
          `SELECT ps."UCID", ps."TaskTitle", ps."OwnerId", ps."TaskId",
                  t."GroupId", ud."Name" AS "DetectedByName"
           FROM "ProjectSchedules" ps
           LEFT JOIN "Tasks" t  ON ps."TaskId"  = t."Id"
           LEFT JOIN "Users" ud ON ud."Id"       = $1
           WHERE ps."Id" = $2`,
          [DetectedById || null, parseInt(ProjectScheduleId)],
        );
        if (scRes.rows.length && scRes.rows[0].OwnerId) {
          const sc = scRes.rows[0];
          const groupName = await getGroupName(sc.GroupId);
const issueUrl = buildGroupUrl(sc.GroupId, groupName);
          emailService.sendNewIssueEmail({
            ownerId: sc.OwnerId,
            groupId: sc.GroupId,
            defectId: withJoins.rows[0].DefectId,
            ucid: sc.UCID,
            ucTitle: sc.TaskTitle,
            severity: Severity || "Minor",
            issueType: IssueType || "Technical",
            description: Description || null,
            detectedByName: sc.DetectedByName || null,
            issueUrl,
          });
        }
      }
    } catch (emailErr) {
      console.error("[createIssue] Lỗi email issue mới:", emailErr.message);
    }

    res.status(201).json({ success: true, data: withJoins.rows[0] });
  } catch (err) {
    console.error("createIssue:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.updateIssue = async (req, res) => {
  try {
    const issueId = parseInt(req.params.issueId);
    const {
      ProjectScheduleId,
      IssueType,
      Severity,
      Description,
      DetectedById,
      StartDate,
      DueDate,
      Status,
      EvidenceUrl,
      IsUrgent,
    } = req.body;

    const cleanStart = StartDate ? StartDate.split("T")[0] : null;
    const cleanDue = DueDate ? DueDate.split("T")[0] : null;

    let finalStatus = Status;
    if (
      cleanDue &&
      finalStatus !== "Tạm miễn" &&
      finalStatus !== "Hoàn thành"
    ) {
      if (
        new Date(cleanDue) < new Date(new Date().toISOString().split("T")[0])
      ) {
        finalStatus = "Đình chỉ";
      }
    }

    await pool.query(
      `UPDATE "IssueTrackings" SET
         "ProjectScheduleId" = $1,
         "IssueType"         = $2,
         "Severity"          = $3,
         "Description"       = $4,
         "DetectedById"      = $5,
         "StartDate"         = $6,
         "DueDate"           = $7,
         "Status"            = $8,
         "EvidenceUrl"       = $9,
         "IsUrgent"          = $10
       WHERE "Id" = $11`,
      [
        ProjectScheduleId || null,
        IssueType || "Technical",
        Severity || "Minor",
        Description || null,
        DetectedById || null,
        cleanStart,
        cleanDue,
        finalStatus,
        EvidenceUrl || null,
        IsUrgent ? true : false,
        issueId,
      ],
    );

    const updated = await pool.query(
      `SELECT it.*, ps."UCID", ps."TaskTitle" AS "UCTaskTitle", ps."OwnerId" AS "ActionOwnerId",
              uo."Name" AS "ActionOwnerName", ud."Name" AS "DetectedByName"
       FROM "IssueTrackings" it
       LEFT JOIN "ProjectSchedules" ps ON it."ProjectScheduleId" = ps."Id"
       LEFT JOIN "Users" uo ON ps."OwnerId" = uo."Id"
       LEFT JOIN "Users" ud ON it."DetectedById" = ud."Id"
       WHERE it."Id" = $1`,
      [issueId],
    );

    if (ProjectScheduleId) {
      await checkAndComplete(parseInt(ProjectScheduleId));
    }

    res.json({ success: true, data: updated.rows[0] });
  } catch (err) {
    console.error("updateIssue:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.deleteIssue = async (req, res) => {
  try {
    const issueId = parseInt(req.params.issueId);

    const issRes = await pool.query(
      `SELECT "ProjectScheduleId", "EvidenceUrl" FROM "IssueTrackings" WHERE "Id" = $1`,
      [issueId],
    );
    const scheduleId = issRes.rows[0]?.ProjectScheduleId;
    const evidenceUrl = issRes.rows[0]?.EvidenceUrl;

    // Xóa ảnh bằng chứng trên Cloudinary nếu là URL nội bộ
    if (evidenceUrl && evidenceUrl.includes("res.cloudinary.com")) {
      try {
        const cloudinary = require("cloudinary").v2;
        const match = evidenceUrl.match(
          /\/upload\/(?:v\d+\/)?(foxtech\/.+?)(?:\.[^.]+)?$/,
        );
        if (match) {
          await cloudinary.uploader.destroy(match[1], {
            resource_type: "image",
          });
        }
      } catch (e) {
        console.warn(
          "[deleteIssue] Xóa Cloudinary thất bại (bỏ qua):",
          e.message,
        );
      }
    }

    await pool.query(`DELETE FROM "IssueTrackings" WHERE "Id" = $1`, [issueId]);

    if (scheduleId) {
      await checkAndComplete(parseInt(scheduleId));
    }

    res.json({ success: true, message: "Đã xóa issue" });
  } catch (err) {
    console.error("deleteIssue:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═════════════════════════════════════════════════════════════
// PROJECT STATS
// ═════════════════════════════════════════════════════════════

exports.getStats = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const schedStats = await pool.query(
      `SELECT "Status", COUNT(*) AS cnt FROM "ProjectSchedules" WHERE "TaskId" = $1 GROUP BY "Status"`,
      [taskId],
    );
    const issueStats = await pool.query(
      `SELECT "Severity", COUNT(*) AS cnt FROM "IssueTrackings" WHERE "TaskId" = $1 GROUP BY "Severity"`,
      [taskId],
    );
    const urgentSch = await pool.query(
      `SELECT COUNT(*) AS cnt FROM "ProjectSchedules" WHERE "TaskId" = $1 AND "IsUrgent" = true`,
      [taskId],
    );
    const urgentIss = await pool.query(
      `SELECT COUNT(*) AS cnt FROM "IssueTrackings" WHERE "TaskId" = $1 AND "IsUrgent" = true`,
      [taskId],
    );
    const iterStats = await pool.query(
      `SELECT "Iteration", COUNT(*) AS cnt FROM "ProjectSchedules" WHERE "TaskId" = $1 GROUP BY "Iteration"`,
      [taskId],
    );
    const cmplxStats = await pool.query(
      `SELECT "Complexity", COUNT(*) AS cnt FROM "ProjectSchedules" WHERE "TaskId" = $1 GROUP BY "Complexity"`,
      [taskId],
    );
    const issTypeStats = await pool.query(
      `SELECT "IssueType", COUNT(*) AS cnt FROM "IssueTrackings" WHERE "TaskId" = $1 GROUP BY "IssueType"`,
      [taskId],
    );

    res.json({
      success: true,
      scheduleStats: schedStats.rows,
      issueStats: issueStats.rows,
      iterStats: iterStats.rows,
      cmplxStats: cmplxStats.rows,
      issTypeStats: issTypeStats.rows,
      urgentSchedule: urgentSch.rows[0].cnt,
      urgentIssue: urgentIss.rows[0].cnt,
    });
  } catch (err) {
    console.error("getStats:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═════════════════════════════════════════════════════════════
// CODE PUSH — Gate 1
// ═════════════════════════════════════════════════════════════

exports.getCodePushes = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const result = await pool.query(
      `SELECT cp.*,
              up."Name" AS "PushedByName", up."AvatarUrl" AS "PushedByAvatar",
              ur."Name" AS "ReviewerName",  ur."AvatarUrl" AS "ReviewerAvatar"
       FROM "UCCodePushes" cp
       LEFT JOIN "Users" up ON cp."PushedById" = up."Id"
       LEFT JOIN "Users" ur ON cp."ReviewerId"  = ur."Id"
       WHERE cp."ProjectScheduleId" = $1
       ORDER BY cp."CreatedAt" DESC`,
      [scheduleId],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("getCodePushes:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.createCodePush = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const taskId = parseInt(req.params.taskId);
    const userId = req.user?.id || req.user?.Id;
    const { CommitUrl, PRUrl, BranchName } = req.body;

    if (!CommitUrl && !PRUrl) {
      return res.status(400).json({
        success: false,
        message:
          "Vui lòng cung cấp ít nhất một đường dẫn commit hoặc pull request.",
      });
    }

    await pool.query(
      `UPDATE "UCCodePushes"
       SET "IsActive" = false
       WHERE "ProjectScheduleId" = $1
         AND "IsActive" = true
         AND "Status" NOT IN ('Đã phê duyệt')`,
      [scheduleId],
    );

    const result = await pool.query(
      `INSERT INTO "UCCodePushes"
         ("ProjectScheduleId", "TaskId", "CommitUrl", "PRUrl", "BranchName", "PushedById", "Status", "IsActive")
       VALUES ($1,$2,$3,$4,$5,$6,'Chờ xác nhận',true)
       RETURNING *`,
      [
        scheduleId,
        taskId,
        CommitUrl || null,
        PRUrl || null,
        BranchName || null,
        userId,
      ],
    );

    const created = result.rows[0];
    const withJoins = await pool.query(
      `SELECT cp.*,
              up."Name" AS "PushedByName", up."AvatarUrl" AS "PushedByAvatar",
              ur."Name" AS "ReviewerName",  ur."AvatarUrl" AS "ReviewerAvatar"
       FROM "UCCodePushes" cp
       LEFT JOIN "Users" up ON cp."PushedById" = up."Id"
       LEFT JOIN "Users" ur ON cp."ReviewerId"  = ur."Id"
       WHERE cp."Id" = $1`,
      [created.Id],
    );
    res.status(201).json({ success: true, data: withJoins.rows[0] });
  } catch (err) {
    console.error("createCodePush:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.reviewCodePush = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const taskId = parseInt(req.params.taskId);
    const pushId = parseInt(req.params.pushId);
    const { action, rejectionNote } = req.body;

    const { canReview } = await getReviewerRole(req, taskId);
    if (!canReview) {
      return res.status(403).json({
        success: false,
        message: "Chỉ Leader hoặc Action Leader mới có quyền phê duyệt.",
      });
    }

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message:
          'Hành động không hợp lệ. Vui lòng sử dụng "approve" hoặc "reject".',
      });
    }

    if (action === "reject" && (!rejectionNote || !rejectionNote.trim())) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập lý do từ chối trước khi tiến hành.",
      });
    }

    const reviewerId = req.user?.id || req.user?.Id;

    const pushRes = await pool.query(
      `SELECT * FROM "UCCodePushes"
       WHERE "Id" = $1 AND "ProjectScheduleId" = $2 AND "IsActive" = true`,
      [pushId, scheduleId],
    );
    if (!pushRes.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy bản ghi code push hợp lệ.",
      });
    }

    if (action === "approve") {
      const openIssues = await pool.query(
        `SELECT COUNT(*) AS cnt, STRING_AGG("DefectId", ', ') AS ids
         FROM "IssueTrackings"
         WHERE "ProjectScheduleId" = $1 AND "Status" != 'Hoàn thành'`,
        [scheduleId],
      );
      const { cnt, ids } = openIssues.rows[0];
      if (parseInt(cnt) > 0) {
        const autoNote = `Hệ thống tự động từ chối: UC vẫn còn ${cnt} lỗi chưa được khắc phục (${ids}). Vui lòng xem chi tiết tại bảng Issue Tracking và xử lý toàn bộ lỗi trước khi yêu cầu phê duyệt lại.`;
        await pool.query(
          `UPDATE "UCCodePushes"
           SET "Status" = 'Bị từ chối', "ReviewerId" = $1, "ReviewedAt" = NOW(), "RejectionNote" = $2
           WHERE "Id" = $3`,
          [reviewerId, autoNote, pushId],
        );
        await fullReset(scheduleId, pushId);
        return res.status(400).json({ success: false, message: autoNote });
      }
    }

    if (action === "approve") {
      await pool.query(
        `UPDATE "UCCodePushes"
         SET "Status" = 'Đã phê duyệt', "ReviewerId" = $1, "ReviewedAt" = NOW()
         WHERE "Id" = $2`,
        [reviewerId, pushId],
      );
      await checkAndComplete(scheduleId);
    } else {
      const note = rejectionNote.trim();
      await pool.query(
        `UPDATE "UCCodePushes"
         SET "Status" = 'Bị từ chối', "ReviewerId" = $1, "ReviewedAt" = NOW(), "RejectionNote" = $2
         WHERE "Id" = $3`,
        [reviewerId, note, pushId],
      );
      await fullReset(scheduleId, pushId);
    }

    const updated = await pool.query(
      `SELECT cp.*,
              up."Name" AS "PushedByName", up."AvatarUrl" AS "PushedByAvatar",
              ur."Name" AS "ReviewerName",  ur."AvatarUrl" AS "ReviewerAvatar"
       FROM "UCCodePushes" cp
       LEFT JOIN "Users" up ON cp."PushedById" = up."Id"
       LEFT JOIN "Users" ur ON cp."ReviewerId"  = ur."Id"
       WHERE cp."Id" = $1`,
      [pushId],
    );

    try {
      const scRes = await pool.query(
        `SELECT ps."UCID", ps."TaskTitle", ps."TaskId", t."GroupId",
                rv."Name" AS "ReviewerName"
         FROM "ProjectSchedules" ps
         LEFT JOIN "Tasks" t ON ps."TaskId" = t."Id"
         LEFT JOIN "Users" rv ON rv."Id"    = $1
         WHERE ps."Id" = $2`,
        [reviewerId, scheduleId],
      );
      if (scRes.rows.length) {
        const sc = scRes.rows[0];
        const groupName = await getGroupName(sc.GroupId);
const pushUrl = buildGroupUrl(sc.GroupId, groupName);
        emailService.sendCodePushReviewEmail({
          pushedById: pushRes.rows[0].PushedById,
          groupId: sc.GroupId,
          action,
          ucid: sc.UCID,
          ucTitle: sc.TaskTitle,
          rejectionNote: action === "reject" ? rejectionNote.trim() : null,
          reviewerName: sc.ReviewerName,
          pushUrl,
        });
      }
    } catch (emailErr) {
      console.error("[reviewCodePush] Lỗi email:", emailErr.message);
    }

    res.json({ success: true, data: updated.rows[0] });
  } catch (err) {
    console.error("reviewCodePush:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// POST /webhook/github
exports.handleGithubWebhook = async (req, res) => {
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET || "";
    const signature = req.headers["x-hub-signature-256"] || "";
    const payload = JSON.stringify(req.body);

    if (secret) {
      const expected =
        "sha256=" +
        crypto.createHmac("sha256", secret).update(payload).digest("hex");
      if (signature !== expected) {
        return res
          .status(401)
          .json({ success: false, message: "Chữ ký webhook không hợp lệ." });
      }
    }

    const event = req.headers["x-github-event"];
    if (event !== "push") {
      return res
        .status(200)
        .json({ success: true, message: "Sự kiện không được xử lý." });
    }

    const sha = req.body?.after;
    const branchFull = req.body?.ref || "";
    const branch = branchFull.replace("refs/heads/", "");

    if (!sha || sha === "0000000000000000000000000000000000000000") {
      return res
        .status(200)
        .json({ success: true, message: "Push rỗng, bỏ qua." });
    }

    const matchRes = await pool.query(
      `SELECT "Id", "ProjectScheduleId"
       FROM "UCCodePushes"
       WHERE "IsActive" = true
         AND "Status" = 'Chờ xác nhận'
         AND (
           "BranchName" = $1
           OR "CommitUrl" LIKE $2
         )
       ORDER BY "CreatedAt" DESC`,
      [branch, "%" + sha.substring(0, 7) + "%"],
    );

    if (!matchRes.rows.length) {
      return res
        .status(200)
        .json({ success: true, message: "Không tìm thấy push tương ứng." });
    }

    const { Id: pushId } = matchRes.rows[0];

    await pool.query(
      `UPDATE "UCCodePushes"
       SET "Status" = 'Chờ phê duyệt', "GithubSha" = $1, "WebhookPayload" = $2
       WHERE "Id" = $3`,
      [sha, payload, pushId],
    );

    res.status(200).json({
      success: true,
      message:
        "Webhook đã được ghi nhận. Trạng thái chuyển sang Chờ phê duyệt.",
    });
  } catch (err) {
    console.error("handleGithubWebhook:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═════════════════════════════════════════════════════════════
// UC DOCUMENTS — Gate 3
// ═════════════════════════════════════════════════════════════

exports.getDocuments = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const result = await pool.query(
      `SELECT d.*,
              uc."Name" AS "CreatedByName", uc."AvatarUrl" AS "CreatedByAvatar",
              ur."Name" AS "ReviewerName",  ur."AvatarUrl" AS "ReviewerAvatar"
       FROM "UCDocuments" d
       LEFT JOIN "Users" uc ON d."CreatedById" = uc."Id"
       LEFT JOIN "Users" ur ON d."ReviewerId"  = ur."Id"
       WHERE d."ProjectScheduleId" = $1
       ORDER BY d."CreatedAt" ASC`,
      [scheduleId],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("getDocuments:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.createDocument = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const taskId = parseInt(req.params.taskId);
    const userId = req.user?.id || req.user?.Id;
    const { Title, DocType, FileUrl } = req.body;

    if (!Title || !Title.trim()) {
      return res.status(400).json({
        success: false,
        message: "Tiêu đề tài liệu không được để trống.",
      });
    }

    const result = await pool.query(
      `INSERT INTO "UCDocuments"
         ("ProjectScheduleId", "TaskId", "Title", "DocType", "FileUrl", "Status", "CreatedById")
       VALUES ($1,$2,$3,$4,$5,'Chưa bắt đầu',$6)
       RETURNING *`,
      [
        scheduleId,
        taskId,
        Title.trim(),
        DocType || "Tài liệu",
        FileUrl || null,
        userId,
      ],
    );

    const created = result.rows[0];
    const withJoins = await pool.query(
      `SELECT d.*,
              uc."Name" AS "CreatedByName", uc."AvatarUrl" AS "CreatedByAvatar",
              ur."Name" AS "ReviewerName",  ur."AvatarUrl" AS "ReviewerAvatar"
       FROM "UCDocuments" d
       LEFT JOIN "Users" uc ON d."CreatedById" = uc."Id"
       LEFT JOIN "Users" ur ON d."ReviewerId"  = ur."Id"
       WHERE d."Id" = $1`,
      [created.Id],
    );
    res.status(201).json({ success: true, data: withJoins.rows[0] });
  } catch (err) {
    console.error("createDocument:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.updateDocument = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const docId = parseInt(req.params.docId);
    const { Title, DocType, FileUrl, Status } = req.body;

    const allowedStatuses = ["Chưa bắt đầu", "Đang soạn thảo", "Chờ phê duyệt"];
    if (Status && !allowedStatuses.includes(Status)) {
      return res.status(400).json({
        success: false,
        message: `Trạng thái "${Status}" không hợp lệ. Vui lòng gửi tài liệu để Leader phê duyệt.`,
      });
    }

    const clearReview =
      Status === "Đang soạn thảo" || Status === "Chờ phê duyệt";

    if (clearReview) {
      await pool.query(
        `UPDATE "UCDocuments"
         SET "Title" = $1, "DocType" = $2, "FileUrl" = $3, "Status" = $4,
             "ReviewerId" = NULL, "ReviewedAt" = NULL, "RejectionNote" = NULL, "UpdatedAt" = NOW()
         WHERE "Id" = $5 AND "ProjectScheduleId" = $6`,
        [
          Title || null,
          DocType || "Tài liệu",
          FileUrl || null,
          Status,
          docId,
          scheduleId,
        ],
      );
    } else {
      await pool.query(
        `UPDATE "UCDocuments"
         SET "Title" = $1, "DocType" = $2, "FileUrl" = $3, "Status" = $4, "UpdatedAt" = NOW()
         WHERE "Id" = $5 AND "ProjectScheduleId" = $6`,
        [
          Title || null,
          DocType || "Tài liệu",
          FileUrl || null,
          Status || "Chưa bắt đầu",
          docId,
          scheduleId,
        ],
      );
    }

    const updated = await pool.query(
      `SELECT d.*,
              uc."Name" AS "CreatedByName", uc."AvatarUrl" AS "CreatedByAvatar",
              ur."Name" AS "ReviewerName",  ur."AvatarUrl" AS "ReviewerAvatar"
       FROM "UCDocuments" d
       LEFT JOIN "Users" uc ON d."CreatedById" = uc."Id"
       LEFT JOIN "Users" ur ON d."ReviewerId"  = ur."Id"
       WHERE d."Id" = $1`,
      [docId],
    );
    res.json({ success: true, data: updated.rows[0] });
  } catch (err) {
    console.error("updateDocument:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.reviewDocument = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const taskId = parseInt(req.params.taskId);
    const docId = parseInt(req.params.docId);
    const { action, rejectionNote } = req.body;

    const { canReview } = await getReviewerRole(req, taskId);
    if (!canReview) {
      return res.status(403).json({
        success: false,
        message:
          "Chỉ Leader hoặc Action Leader mới có quyền phê duyệt tài liệu.",
      });
    }

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message:
          'Hành động không hợp lệ. Vui lòng sử dụng "approve" hoặc "reject".',
      });
    }

    if (action === "reject" && (!rejectionNote || !rejectionNote.trim())) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập lý do yêu cầu chỉnh sửa trước khi tiến hành.",
      });
    }

    const reviewerId = req.user?.id || req.user?.Id;

    const docRes = await pool.query(
      `SELECT * FROM "UCDocuments" WHERE "Id" = $1 AND "ProjectScheduleId" = $2`,
      [docId, scheduleId],
    );
    if (!docRes.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy tài liệu." });
    }

    if (docRes.rows[0].Status !== "Chờ phê duyệt") {
      return res.status(400).json({
        success: false,
        message: `Tài liệu chưa được gửi duyệt. Trạng thái hiện tại: "${docRes.rows[0].Status}".`,
      });
    }

    if (action === "approve") {
      await pool.query(
        `UPDATE "UCDocuments"
         SET "Status" = 'Đã phê duyệt', "ReviewerId" = $1, "ReviewedAt" = NOW(), "UpdatedAt" = NOW()
         WHERE "Id" = $2`,
        [reviewerId, docId],
      );
      await checkAndComplete(scheduleId);
    } else {
      await pool.query(
        `UPDATE "UCDocuments"
         SET "Status" = 'Cần chỉnh sửa', "ReviewerId" = $1, "ReviewedAt" = NOW(),
             "RejectionNote" = $2, "UpdatedAt" = NOW()
         WHERE "Id" = $3`,
        [reviewerId, rejectionNote.trim(), docId],
      );
    }

    const updated = await pool.query(
      `SELECT d.*,
              uc."Name" AS "CreatedByName", uc."AvatarUrl" AS "CreatedByAvatar",
              ur."Name" AS "ReviewerName",  ur."AvatarUrl" AS "ReviewerAvatar"
       FROM "UCDocuments" d
       LEFT JOIN "Users" uc ON d."CreatedById" = uc."Id"
       LEFT JOIN "Users" ur ON d."ReviewerId"  = ur."Id"
       WHERE d."Id" = $1`,
      [docId],
    );

    try {
      const doc = updated.rows[0];
      if (doc?.CreatedById) {
        const scRes = await pool.query(
          `SELECT ps."UCID", ps."TaskTitle", ps."TaskId", t."GroupId"
           FROM "ProjectSchedules" ps
           LEFT JOIN "Tasks" t ON ps."TaskId" = t."Id"
           WHERE ps."Id" = $1`,
          [scheduleId],
        );
        const sc = scRes.rows[0];
        const reviewerRes = await pool.query(
          `SELECT "Name" FROM "Users" WHERE "Id" = $1`,
          [reviewerId],
        );
        const reviewerName = reviewerRes.rows[0]?.Name || "Leader";
        const groupName = await getGroupName(sc?.GroupId);
const docUrl = buildGroupUrl(sc?.GroupId, groupName);

        emailService.sendDocumentReviewEmail({
          createdById: doc.CreatedById,
          groupId: sc?.GroupId,
          action,
          ucid: sc?.UCID || "",
          ucTitle: sc?.TaskTitle || "",
          docTitle: doc.Title,
          docType: doc.DocType,
          rejectionNote: action === "reject" ? rejectionNote?.trim() : null,
          reviewerName,
          docUrl,
        });
      }
    } catch (emailErr) {
      console.error("[reviewDocument] Lỗi email:", emailErr.message);
    }

    res.json({ success: true, data: updated.rows[0] });
  } catch (err) {
    console.error("reviewDocument:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.deleteDocument = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);
    const docId = parseInt(req.params.docId);

    const docRes = await pool.query(
      `SELECT "Status" FROM "UCDocuments" WHERE "Id" = $1 AND "ProjectScheduleId" = $2`,
      [docId, scheduleId],
    );
    if (!docRes.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy tài liệu." });
    }
    if (docRes.rows[0].Status === "Đã phê duyệt") {
      return res.status(400).json({
        success: false,
        message: "Không thể xóa tài liệu đã được phê duyệt.",
      });
    }

    await pool.query(`DELETE FROM "UCDocuments" WHERE "Id" = $1`, [docId]);
    res.json({ success: true, message: "Đã xóa tài liệu." });
  } catch (err) {
    console.error("deleteDocument:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═════════════════════════════════════════════════════════════
// GATE STATUS
// ═════════════════════════════════════════════════════════════

exports.getGateStatus = async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.scheduleId);

    const gates = await checkAndComplete(scheduleId);

    const techIssues = await pool.query(
      `SELECT "Id", "DefectId", "Description", "Severity", "Status", "DueDate"
       FROM "IssueTrackings"
       WHERE "ProjectScheduleId" = $1 AND "IssueType" = 'Technical'
       ORDER BY
         CASE "Status" WHEN 'Hoàn thành' THEN 1 ELSE 0 END ASC,
         "CreatedAt" DESC`,
      [scheduleId],
    );

    const docIssues = await pool.query(
      `SELECT "Id", "DefectId", "Description", "Severity", "Status", "DueDate"
       FROM "IssueTrackings"
       WHERE "ProjectScheduleId" = $1 AND "IssueType" = 'Document'
       ORDER BY
         CASE "Status" WHEN 'Hoàn thành' THEN 1 ELSE 0 END ASC,
         "CreatedAt" DESC`,
      [scheduleId],
    );

    const sonarHistory = await pool.query(
      `SELECT "Id", "QualityStatus", "Branch", "BugCount", "VulnerabilityCount",
              "CodeSmellCount", "CoveragePercent", "DuplicationsPercent",
              "DashboardUrl", "CreatedAt"
       FROM "SonarQubeResults"
       WHERE "ScheduleId" = $1
       ORDER BY "CreatedAt" DESC
       LIMIT 5`,
      [scheduleId],
    );

    const pushRes = await pool.query(
      `SELECT cp.*,
              up."Name" AS "PushedByName", ur."Name" AS "ReviewerName"
       FROM "UCCodePushes" cp
       LEFT JOIN "Users" up ON cp."PushedById" = up."Id"
       LEFT JOIN "Users" ur ON cp."ReviewerId"  = ur."Id"
       WHERE cp."ProjectScheduleId" = $1 AND cp."IsActive" = true
       ORDER BY cp."CreatedAt" DESC
       LIMIT 1`,
      [scheduleId],
    );

    const docRes = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN "Status" = 'Đã phê duyệt' THEN 1 ELSE 0 END) AS approved
       FROM "UCDocuments"
       WHERE "ProjectScheduleId" = $1`,
      [scheduleId],
    );

    res.json({
      success: true,
      gates,
      detail: {
        technicalIssues: techIssues.rows,
        documentIssues: docIssues.rows,
        sonarHistory: sonarHistory.rows,
        latestPush: pushRes.rows[0] || null,
        documentStats: docRes.rows[0],
      },
    });
  } catch (err) {
    console.error("getGateStatus:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═══════════════════════════════════════════════════════════
// GITHUB TAB CONTROLLERS
// ═══════════════════════════════════════════════════════════

exports.getGithubConfig = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const result = await pool.query(
      `SELECT "RepoUrl", "RepoOwner", "RepoName",
              CASE WHEN "GithubToken" IS NOT NULL AND "GithubToken" != '' THEN true ELSE false END AS "HasToken"
       FROM "GitHubConfigs" WHERE "TaskId" = $1`,
      [taskId],
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    console.error("getGithubConfig:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server: " + err.message });
  }
};

exports.saveGithubConfig = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const { repoUrl, githubToken } = req.body;
    let owner = null,
      repo = null;
    if (repoUrl) {
      const m = repoUrl.match(
        /github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/,
      );
      if (m) {
        owner = m[1];
        repo = m[2];
      }
    }
    await pool.query(
      `INSERT INTO "GitHubConfigs" ("TaskId", "RepoUrl", "RepoOwner", "RepoName", "GithubToken", "UpdatedAt")
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT ("TaskId") DO UPDATE SET
         "RepoUrl"     = EXCLUDED."RepoUrl",
         "RepoOwner"   = EXCLUDED."RepoOwner",
         "RepoName"    = EXCLUDED."RepoName",
         "GithubToken" = EXCLUDED."GithubToken",
         "UpdatedAt"   = NOW()`,
      [taskId, repoUrl || null, owner, repo, githubToken || null],
    );
    res.json({
      success: true,
      data: { repoUrl, owner, repo, hasToken: !!githubToken },
    });
  } catch (err) {
    console.error("saveGithubConfig:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server: " + err.message });
  }
};

exports.proxyGithubApi = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const cfgRes = await pool.query(
      `SELECT "RepoOwner", "RepoName", "GithubToken" FROM "GitHubConfigs" WHERE "TaskId" = $1`,
      [taskId],
    );
    const cfg = cfgRes.rows[0];
    if (!cfg)
      return res
        .status(404)
        .json({ success: false, message: "Chưa cấu hình repo" });

    const { path: apiPath, ...rest } = req.query;
    if (!apiPath)
      return res.status(400).json({ success: false, message: "Thiếu path" });

    const resolvedPath = apiPath
      .replace("{owner}", cfg.RepoOwner)
      .replace("{repo}", cfg.RepoName);

    const qs = new URLSearchParams(rest).toString();
    const url = `https://api.github.com${resolvedPath}${qs ? "?" + qs : ""}`;

    const headers = {
      "User-Agent": "StudyGroupSystem/1.0",
      Accept: "application/vnd.github+json",
    };
    if (cfg.GithubToken) headers["Authorization"] = `Bearer ${cfg.GithubToken}`;

    const ghRes = await fetch(url, { headers });
    const body = await ghRes.json();
    res.status(200).json({
      _githubStatus: ghRes.status,
      _ok: ghRes.ok,
      ...(Array.isArray(body) ? { data: body } : body),
    });
  } catch (err) {
    console.error("proxyGithubApi:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi proxy: " + err.message });
  }
};

exports.getWebhookLogs = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const result = await pool.query(
      `SELECT cp."Id", cp."BranchName", cp."GithubSha", cp."CommitUrl", cp."PRUrl",
              cp."Status", cp."CreatedAt", cp."ReviewedAt",
              u."Name" AS "PushedBy"
       FROM "UCCodePushes" cp
       LEFT JOIN "Users" u ON u."Id" = cp."PushedById"
       WHERE cp."TaskId" = $1 AND cp."GithubSha" IS NOT NULL
       ORDER BY cp."CreatedAt" DESC
       LIMIT 50`,
      [taskId],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("getWebhookLogs:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server: " + err.message });
  }
};

// ═══════════════════════════════════════════════════════════════
// SONARQUBE WEBHOOK
// ═══════════════════════════════════════════════════════════════

exports.handleSonarQubeWebhook = async (req, res) => {
  try {
    const rawPayload = JSON.stringify(req.body);

    const secret = process.env.SONARQUBE_WEBHOOK_SECRET || "";
    if (secret) {
      const signature = req.headers["x-sonar-webhook-hmac-sha256"] || "";
      const expected = crypto
        .createHmac("sha256", secret)
        .update(rawPayload)
        .digest("hex");
      if (signature !== expected) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid signature" });
      }
    }

    const payload = req.body;
    const projectKey = payload?.project?.key || "";
    const qualityGate = payload?.qualityGate;
    const status = qualityGate?.status || "ERROR";
    const branch =
      payload?.branch?.name ||
      payload?.properties?.["sonar.branch.name"] ||
      null;
const commitHash =
      payload?.revision ||
      payload?.properties?.["sonar.analysis.scm.revision"] ||
      null;
    if (!projectKey) {
      return res
        .status(400)
        .json({ success: false, message: "Missing project key" });
    }

    const cfgRes = await pool.query(
      `SELECT "TaskId" FROM "SonarQubeConfigs" WHERE "ProjectKey" = $1`,
      [projectKey],
    );
    if (!cfgRes.rows.length) {
      console.warn(
        `[SonarQube] Webhook nhận được nhưng không tìm thấy config cho projectKey="${projectKey}"`,
      );
      return res
        .status(200)
        .json({ success: true, message: "ProjectKey không khớp, bỏ qua." });
    }
    const taskId = cfgRes.rows[0].TaskId;

    let bugCount = 0,
      vulnCount = 0,
      smellCount = 0;
    let coveragePct = null,
      dupPct = null;
    const conditions = qualityGate?.conditions || [];
    for (const c of conditions) {
      const m = (c.metric || "").toLowerCase();
      const v = parseFloat(c.value) || 0;
      if (m === "bugs") bugCount = v;
      if (m === "vulnerabilities") vulnCount = v;
      if (m === "code_smells") smellCount = v;
      if (m === "coverage") coveragePct = v;
      if (m === "duplicated_lines_density") dupPct = v;
    }

    let scheduleId = null;
    if (branch) {
      const ucidMatch = branch.match(/([A-Z]+-\d+|UC[-_]\d+)/i);
      const ucid = ucidMatch ? ucidMatch[1].toUpperCase() : branch;

      const schedRes = await pool.query(
        `SELECT "Id" FROM "ProjectSchedules"
         WHERE "TaskId" = $1
           AND (UPPER("UCID") = UPPER($2) OR UPPER("UCID") = UPPER($3))`,
        [taskId, ucid, branch],
      );
      if (schedRes.rows.length) {
        scheduleId = schedRes.rows[0].Id;
      }
    }

    const serverUrl = payload?.serverUrl || "https://sonarcloud.io";
    const dashboardUrl = `${serverUrl}/dashboard?id=${encodeURIComponent(projectKey)}`;

    const insertRes = await pool.query(
      `INSERT INTO "SonarQubeResults"
         ("TaskId", "ScheduleId", "QualityStatus", "Branch",
          "BugCount", "VulnerabilityCount", "CodeSmellCount",
          "CoveragePercent", "DuplicationsPercent",
          "RawPayload", "DashboardUrl", "ProjectKey","CommitHash", "CreatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       RETURNING "Id"`,
      [
        taskId,
        scheduleId || null,
        status,
        branch || null,
        bugCount,
        vulnCount,
        smellCount,
        coveragePct,
        dupPct,
        rawPayload,
        dashboardUrl,
        projectKey,
         commitHash
      ],
    );
    const newId = insertRes.rows[0]?.Id;

    if (scheduleId) {
      await checkAndComplete(scheduleId);
    }

    try {
      const taskRes = await pool.query(
        `SELECT t."GroupId", t."Title" AS "TaskName" FROM "Tasks" t WHERE t."Id" = $1`,
        [taskId],
      );
      if (taskRes.rows.length) {
        const { GroupId, TaskName } = taskRes.rows[0];
        const memberIds = await getGroupMemberIds(GroupId);

        const icon = status === "OK" ? "✅" : "❌";
        const detail =
          status === "OK"
            ? "Không có lỗi nghiêm trọng, Quality Gate đạt."
            : `Phát hiện: ${bugCount} bug, ${vulnCount} lỗ hổng, ${smellCount} code smell.`;

        await createNotifications({
          userIds: memberIds,
          title: `SonarQube ${status === "OK" ? "Pass" : "Fail"}: ${projectKey}`,
          message: `${icon} Phân tích mã nguồn ${branch ? `nhánh <strong>${branch}</strong>` : ""} — ${detail} <a href="${dashboardUrl}" target="_blank">Xem chi tiết</a>`,
          type: "alert",
          category: "task",
          groupId: GroupId,
          senderId: null,
          referenceId: taskId,
          skipSelf: false,
        });
      }
    } catch (notifErr) {
      console.error("[SonarQube] Notification error:", notifErr.message);
    }

    res.status(200).json({
      success: true,
      message: "SonarQube result saved",
      id: newId,
      status,
      scheduleId,
    });
  } catch (err) {
    console.error("handleSonarQubeWebhook:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.getSonarConfig = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const result = await pool.query(
      `SELECT "ProjectKey", "ServerUrl",
              CASE WHEN "ApiToken" IS NOT NULL AND "ApiToken" != '' THEN true ELSE false END AS "HasToken",
              CASE WHEN "WebhookSecret" IS NOT NULL AND "WebhookSecret" != '' THEN true ELSE false END AS "HasSecret"
       FROM "SonarQubeConfigs" WHERE "TaskId" = $1`,
      [taskId],
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    console.error("getSonarConfig:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.saveSonarConfig = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const { projectKey, serverUrl, apiToken, webhookSecret } = req.body;

    await pool.query(
      `INSERT INTO "SonarQubeConfigs" ("TaskId", "ProjectKey", "ServerUrl", "ApiToken", "WebhookSecret", "UpdatedAt")
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT ("TaskId") DO UPDATE SET
         "ProjectKey"    = EXCLUDED."ProjectKey",
         "ServerUrl"     = EXCLUDED."ServerUrl",
         "ApiToken"      = EXCLUDED."ApiToken",
         "WebhookSecret" = EXCLUDED."WebhookSecret",
         "UpdatedAt"     = NOW()`,
      [
        taskId,
        projectKey || null,
        serverUrl || "https://sonarcloud.io",
        apiToken || null,
        webhookSecret || null,
      ],
    );
    res.json({ success: true, message: "Đã lưu cấu hình SonarQube" });
  } catch (err) {
    console.error("saveSonarConfig:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.getSonarResults = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const scheduleId = req.query.scheduleId
      ? parseInt(req.query.scheduleId)
      : null;

    let result;
    if (scheduleId) {
      result = await pool.query(
        `SELECT "Id", "QualityStatus", "Branch", "BugCount", "VulnerabilityCount",
                "CodeSmellCount", "CoveragePercent", "DuplicationsPercent",
                "DashboardUrl", "RawPayload", "CreatedAt"
         FROM "SonarQubeResults"
         WHERE "ScheduleId" = $1
         ORDER BY "CreatedAt" DESC
         LIMIT 10`,
        [scheduleId],
      );
    } else {
      result = await pool.query(
        `SELECT "Id", "QualityStatus", "Branch", "BugCount", "VulnerabilityCount",
                "CodeSmellCount", "CoveragePercent", "DuplicationsPercent",
                "DashboardUrl", "ScheduleId", "CreatedAt"
         FROM "SonarQubeResults"
         WHERE "TaskId" = $1
         ORDER BY "CreatedAt" DESC
         LIMIT 20`,
        [taskId],
      );
    }
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("getSonarResults:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═══════════════════════════════════════════════════════════════
// WORKLOAD STATS
// ═══════════════════════════════════════════════════════════════

exports.getWorkloadStats = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);

    const taskRes = await pool.query(
      `SELECT "GroupId" FROM "Tasks" WHERE "Id" = $1`,
      [taskId],
    );
    if (!taskRes.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Task không tồn tại" });
    }
    const groupId = taskRes.rows[0].GroupId;

    const membersRes = await pool.query(
      `SELECT gm."UserId", u."Name", u."AvatarUrl", gm."GroupRole"
       FROM "GroupMembers" gm
       JOIN "Users" u ON u."Id" = gm."UserId"
       WHERE gm."GroupId" = $1
       ORDER BY u."Name" ASC`,
      [groupId],
    );

    const schedStats = await pool.query(
      `SELECT
         "OwnerId",
         COUNT(*) AS total,
         SUM(CASE WHEN "Status" NOT IN ('Hoàn thành', 'Tạm miễn') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN "Status" = 'Hoàn thành'  THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN "Status" = 'Đình chỉ'    THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN "IsUrgent" = true AND "Status" NOT IN ('Hoàn thành', 'Tạm miễn') THEN 1 ELSE 0 END) AS "urgentActive"
       FROM "ProjectSchedules"
       WHERE "TaskId" = $1
       GROUP BY "OwnerId"`,
      [taskId],
    );

    const statsMap = {};
    for (const row of schedStats.rows) {
      if (row.OwnerId) statsMap[row.OwnerId] = row;
    }

    const maxActive = Math.max(
      1,
      ...Object.values(statsMap).map((s) => s.active),
    );

    const members = membersRes.rows.map((m) => {
      const s = statsMap[m.UserId] || {
        total: 0,
        active: 0,
        completed: 0,
        overdue: 0,
        urgentActive: 0,
      };
      return {
        userId: m.UserId,
        name: m.Name,
        avatarUrl: m.AvatarUrl,
        groupRole: m.GroupRole,
        total: s.total,
        active: s.active,
        completed: s.completed,
        overdue: s.overdue,
        urgentActive: s.urgentActive,
        loadPercent: Math.round((s.active / maxActive) * 100),
      };
    });

    res.json({ success: true, data: members, maxActive });
  } catch (err) {
    console.error("getWorkloadStats:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═══════════════════════════════════════════════════════════════
// OVERDUE LOGS
// ═══════════════════════════════════════════════════════════════

exports.getOverdueLogs = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const { handled } = req.query;

    let result;
    if (handled === "0") {
      result = await pool.query(
        `SELECT ol.*, u."Name" AS "HandlerName"
         FROM "OverdueLogs" ol
         LEFT JOIN "Users" u ON u."Id" = ol."HandledBy"
         WHERE ol."TaskId" = $1 AND ol."HandledAt" IS NULL
         ORDER BY ol."OverdueAt" DESC`,
        [taskId],
      );
    } else if (handled === "1") {
      result = await pool.query(
        `SELECT ol.*, u."Name" AS "HandlerName"
         FROM "OverdueLogs" ol
         LEFT JOIN "Users" u ON u."Id" = ol."HandledBy"
         WHERE ol."TaskId" = $1 AND ol."HandledAt" IS NOT NULL
         ORDER BY ol."HandledAt" DESC`,
        [taskId],
      );
    } else {
      result = await pool.query(
        `SELECT ol.*, u."Name" AS "HandlerName"
         FROM "OverdueLogs" ol
         LEFT JOIN "Users" u ON u."Id" = ol."HandledBy"
         WHERE ol."TaskId" = $1
         ORDER BY ol."OverdueAt" DESC`,
        [taskId],
      );
    }

    const unhandled = await pool.query(
      `SELECT COUNT(*) AS cnt FROM "OverdueLogs" WHERE "TaskId" = $1 AND "HandledAt" IS NULL`,
      [taskId],
    );

    res.json({
      success: true,
      data: result.rows,
      unhandledCount: unhandled.rows[0].cnt,
    });
  } catch (err) {
    console.error("getOverdueLogs:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.handleOverdueLog = async (req, res) => {
  try {
    const logId = parseInt(req.params.logId);
    const taskId = parseInt(req.params.taskId);
    const userId = req.user?.id || req.user?.Id;
    const { note } = req.body;

    await pool.query(
      `UPDATE "OverdueLogs"
       SET "HandledAt" = NOW(), "HandledBy" = $1, "HandlerNote" = $2
       WHERE "Id" = $3 AND "TaskId" = $4`,
      [userId, note || null, logId, taskId],
    );

    res.json({ success: true, message: "Đã đánh dấu xử lý" });
  } catch (err) {
    console.error("handleOverdueLog:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═══════════════════════════════════════════════════════════════
// PROJECT SETTINGS
// ═══════════════════════════════════════════════════════════════

exports.getProjectSettings = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const key = req.query.key || "schedule";

    const result = await pool.query(
      `SELECT "SettingsJson", "UpdatedAt", "UpdatedBy"
       FROM "ProjectSettings"
       WHERE "TaskId" = $1 AND "SettingKey" = $2`,
      [taskId, key],
    );

    if (!result.rows.length) {
      return res.json({ success: true, data: null });
    }

    let parsed;
    try {
      parsed = JSON.parse(result.rows[0].SettingsJson);
    } catch {
      parsed = null;
    }

    res.json({
      success: true,
      data: parsed,
      updatedAt: result.rows[0].UpdatedAt,
    });
  } catch (err) {
    console.error("getProjectSettings:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.saveProjectSettings = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const key = req.query.key || "schedule";
    const userId = req.user?.id || req.user?.Id;

    const taskRes = await pool.query(
      `SELECT "GroupId" FROM "Tasks" WHERE "Id" = $1`,
      [taskId],
    );
    if (!taskRes.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Task không tồn tại" });
    }
    const groupId = taskRes.rows[0].GroupId;
    const roleRes = await pool.query(
      `SELECT "GroupRole" FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [groupId, userId],
    );
    const groupRole = (roleRes.rows[0]?.GroupRole || "").toLowerCase();
    const systemRole = (req.user?.role || req.user?.Role || "").toLowerCase();
    const isLeader = groupRole === "leader" || systemRole === "admin";

    if (!isLeader) {
      return res.status(403).json({
        success: false,
        message: "Chỉ Leader mới có thể thay đổi cài đặt nhóm.",
      });
    }

    const settingsJson = JSON.stringify(req.body);

    await pool.query(
      `INSERT INTO "ProjectSettings" ("TaskId", "SettingKey", "SettingsJson", "UpdatedBy", "UpdatedAt")
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT ("TaskId", "SettingKey") DO UPDATE SET
         "SettingsJson" = EXCLUDED."SettingsJson",
         "UpdatedBy"    = EXCLUDED."UpdatedBy",
         "UpdatedAt"    = NOW()`,
      [taskId, key, settingsJson, userId],
    );

    res.json({ success: true, message: "Đã lưu cài đặt cho toàn nhóm" });
  } catch (err) {
    console.error("saveProjectSettings:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ═══════════════════════════════════════════════════════════════
// REMIND
// ═══════════════════════════════════════════════════════════════

exports.sendReminder = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const scheduleId = parseInt(req.params.scheduleId);
    const senderId = req.user?.id || req.user?.Id;
    const { channel = "notification", userIds, message } = req.body;

    const scRes = await pool.query(
      `SELECT ps."UCID", ps."TaskTitle", ps."DueDate", ps."TaskId",
              t."GroupId", ps."OwnerId"
       FROM "ProjectSchedules" ps
       LEFT JOIN "Tasks" t ON ps."TaskId" = t."Id"
       WHERE ps."Id" = $1 AND ps."TaskId" = $2`,
      [scheduleId, taskId],
    );
    if (!scRes.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy UC" });
    }
    const sc = scRes.rows[0];

    let targetIds =
      Array.isArray(userIds) && userIds.length > 0
        ? userIds.map(Number)
        : await getGroupMemberIds(sc.GroupId);

    const groupName = await getGroupName(sc.GroupId);
const taskUrl = buildGroupUrl(sc.GroupId, groupName);
    const customMsg =
      message?.trim() ||
      `Nhắc nhở: UC <strong>${sc.UCID} — ${sc.TaskTitle}</strong> cần được chú ý.`;
    const dueDateStr = sc.DueDate ? sc.DueDate.toString().split("T")[0] : null;

    if (channel === "notification" || channel === "both") {
      await createNotifications({
        userIds: targetIds,
        title: `Nhắc nhở: ${sc.UCID}`,
        message: customMsg,
        type: "task",
        category: "task",
        groupId: sc.GroupId,
        senderId,
        referenceId: taskId,
        skipSelf: false,
      });
    }

    if (channel === "email" || channel === "both") {
      for (const uid of targetIds) {
        emailService.sendDeadlineReminderEmail({
          userId: uid,
          taskTitle: `${sc.UCID} — ${sc.TaskTitle}`,
          dueDate: dueDateStr,
          groupId: sc.GroupId,
          taskUrl,
        });
      }
    }

    res.json({
      success: true,
      message: `Đã gửi nhắc nhở đến ${targetIds.length} người.`,
    });
  } catch (err) {
    console.error("sendReminder:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.sendIssueReminder = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const issueId = parseInt(req.params.issueId);
    const senderId = req.user?.id || req.user?.Id;
    const { channel = "notification", userIds, message } = req.body;

    const issRes = await pool.query(
      `SELECT it."DefectId", it."Description", it."DueDate",
              it."TaskId", ps."OwnerId",
              t."GroupId"
       FROM "IssueTrackings" it
       LEFT JOIN "ProjectSchedules" ps ON it."ProjectScheduleId" = ps."Id"
       LEFT JOIN "Tasks" t ON it."TaskId" = t."Id"
       WHERE it."Id" = $1 AND it."TaskId" = $2`,
      [issueId, taskId],
    );
    if (!issRes.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy Issue" });
    }
    const issue = issRes.rows[0];

    let targetIds =
      Array.isArray(userIds) && userIds.length > 0
        ? userIds.map(Number)
        : issue.OwnerId
          ? [issue.OwnerId]
          : await getGroupMemberIds(issue.GroupId);

    const groupName = await getGroupName(issue.GroupId);
const taskUrl = buildGroupUrl(issue.GroupId, groupName);
    const customMsg =
      message?.trim() ||
      `Nhắc nhở: Issue <strong>${issue.DefectId}</strong> cần được xử lý.`;
    const dueDateStr = issue.DueDate
      ? issue.DueDate.toString().split("T")[0]
      : null;

    if (channel === "notification" || channel === "both") {
      await createNotifications({
        userIds: targetIds,
        title: `Nhắc nhở Issue: ${issue.DefectId}`,
        message: customMsg,
        type: "alert",
        category: "task",
        groupId: issue.GroupId,
        senderId,
        referenceId: taskId,
        skipSelf: false,
      });
    }

    if (channel === "email" || channel === "both") {
      for (const uid of targetIds) {
        emailService.sendDeadlineReminderEmail({
          userId: uid,
          taskTitle: `Issue ${issue.DefectId}: ${issue.Description?.substring(0, 60) || ""}`,
          dueDate: dueDateStr,
          groupId: issue.GroupId,
          taskUrl,
        });
      }
    }

    res.json({
      success: true,
      message: `Đã gửi nhắc nhở đến ${targetIds.length} người.`,
    });
  } catch (err) {
    console.error("sendIssueReminder:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

exports.assignSonarResult = async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const { resultId } = req.params;
    const { scheduleId } = req.body;
    await pool.query(
      `UPDATE "SonarQubeResults" SET "ScheduleId" = $1 WHERE "Id" = $2`,
      [scheduleId, resultId, taskId]
    );
    if (scheduleId) await checkAndComplete(scheduleId);
    res.json({ success: true });
  } catch (err) {
    console.error("assignSonarResult:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};