const { pool } = require("../config/db");
const {
  createNotifications,
  getGroupMemberIds,
} = require("../utils/notificationHelper");

// ── Email service (fire-and-forget, không block response) ──
const emailService = require("../utils/emailService");

// ==========================================
// 1. [GET] Lấy danh sách Môn học (Chuyển từ Route sang)
// ==========================================
exports.getSubjects = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT "SubjectCode", "SubjectName", "SubjectNameVN" 
      FROM "Subjects" 
      ORDER BY "SubjectCode" ASC
    `);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Lỗi lấy danh sách môn học:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi Server khi lấy danh sách môn học",
    });
  }
};

// ==========================================
// 2. [GET] Tìm kiếm Giảng viên (Chuyển từ Route sang)
// ==========================================
exports.searchLecturers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    const searchPattern = `%${q}%`;
    const result = await pool.query(
      `
      SELECT "Id", "Name", "Email", "LecturerCode", "UniversityId"
      FROM "Lecturers"
      WHERE (
        "Name" ILIKE $1 
        OR "LecturerCode" ILIKE $1 
        OR CAST("UniversityId" AS VARCHAR) LIKE $1
      )
      AND "IsActive" = true
      LIMIT 10
    `,
      [searchPattern],
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Lỗi tìm kiếm giảng viên:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tìm kiếm giảng viên" });
  }
};

// ==========================================
// 3. [POST] Tạo nhóm mới (hoặc gửi yêu cầu duyệt nhóm)
// ==========================================
exports.createGroup = async (req, res) => {
  try {
    const {
      semester,
      termNumber,
      className,
      subjectCode,
      groupNumber,
      description,
      name,
      members = [],
      newAccountRequests = [],
    } = req.body;

    if (!subjectCode || subjectCode === "Chung") {
      return res
        .status(400)
        .json({ success: false, message: "Vui lòng chọn môn học hợp lệ!" });
    }

    if (!className || !groupNumber || !name) {
      return res.status(400).json({
        success: false,
        message: "Thiếu thông tin cơ bản để tạo đơn!",
      });
    }

    await pool.query(
      `INSERT INTO "GroupRequests" (
        "GroupName", "SubjectCode", "Description", "CreatedBy", "Status", 
        "ClassName", "Semester", "GroupNumber", "TermNumber", "MemberEmails", 
        "NewAccountRequestsJson", "CreatedAt"
      )
      VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, NOW())`,
      [
        name,
        subjectCode,
        description || "",
        req.user.id,
        className,
        semester,
        groupNumber,
        termNumber,
        JSON.stringify(members),
        JSON.stringify(newAccountRequests),
      ],
    );

    res.status(201).json({
      success: true,
      message: "Yêu cầu tạo nhóm đã được gửi tới Admin chờ phê duyệt!",
    });
  } catch (err) {
    console.error("Lỗi khi tạo GroupRequest:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server khi tạo nhóm!" });
  }
};

// ==========================================
// 4. [POST] Thêm thành viên vào nhóm
// ==========================================
exports.addMember = async (req, res) => {
  try {
    const groupId = req.params.groupId || req.body.groupId;
    const { email } = req.body;

    if (!groupId || !email) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu groupId hoặc email!" });
    }

    const user = await pool.query(
      `SELECT "Id", "Name" FROM "Users" WHERE "Email" = $1`,
      [email],
    );
    if (user.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy người dùng này!" });
    }
    const { Id: userId, Name: userName } = user.rows[0];

    const isExist = await pool.query(
      `SELECT "Id" FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [groupId, userId],
    );
    if (isExist.rows.length > 0) {
      return res
        .status(400)
        .json({ success: false, message: "Thành viên này đã có trong nhóm!" });
    }

    await pool.query(
      `INSERT INTO "GroupMembers"("GroupId", "UserId", "GroupRole") VALUES($1, $2, 'User')`,
      [groupId, userId],
    );

    // Notification & Email (fire-and-forget)
    try {
      const groupRes = await pool.query(
        `SELECT "Name" FROM "Groups" WHERE "Id" = $1`,
        [groupId],
      );
      const groupName = groupRes.rows[0]?.Name || "Nhóm";

      await createNotifications({
        userIds: [userId],
        title: "Bạn được thêm vào nhóm",
        message: `Bạn đã được thêm vào nhóm <strong>${groupName}</strong>.`,
        type: "group",
        category: "group",
        groupId: parseInt(groupId),
        senderId: req.user.id,
        referenceId: parseInt(groupId),
        skipSelf: false,
      });

      const addedByRes = await pool.query(
        `SELECT "Name" FROM "Users" WHERE "Id" = $1`,
        [req.user.id],
      );
      const addedByName = addedByRes.rows[0]?.Name || "Leader";
      const groupUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/group/${groupId}`;

      emailService.sendMemberAddedEmail({
        userId,
        groupId: parseInt(groupId),
        groupName,
        addedByName,
        groupUrl,
      });
    } catch (notifErr) {
      console.error("[addMember] Lỗi notification/email:", notifErr.message);
    }

    res
      .status(200)
      .json({ success: true, message: "Đã thêm thành viên thành công!" });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server khi thêm thành viên." });
  }
};

// ==========================================
// 5. [GET] Lấy danh sách TẤT CẢ các nhóm (Admin)
// ==========================================
exports.getAllGroups = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
          g."Id" as "GroupId", g."Name" as "GroupName", g."ClassName", g."Semester", g."Description",
          s."SubjectCode", s."SubjectName", g."CreatedAt"
      FROM "Groups" g
      LEFT JOIN "Subjects" s ON g."SubjectCode" = s."SubjectCode"
      ORDER BY g."CreatedAt" DESC
    `);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server khi lấy danh sách nhóm." });
  }
};

// ==========================================
// 6. [GET] Lấy danh sách nhóm của MÌNH
// ==========================================
exports.getMyGroups = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT 
        g.*, 
        s."SubjectName", 
        gm."GroupRole",
        (SELECT COUNT(*) FROM "GroupMembers" WHERE "GroupId" = g."Id") AS "MemberCount"
      FROM "Groups" g
      JOIN "GroupMembers" gm ON g."Id" = gm."GroupId"
      LEFT JOIN "Subjects" s ON g."SubjectCode" = s."SubjectCode"
      WHERE gm."UserId" = $1
      ORDER BY g."CreatedAt" DESC
    `,
      [req.user.id],
    );
    res.status(200).json({ success: true, data: result.rows }); // Đã tích hợp đếm MemberCount
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server khi lấy nhóm của tôi." });
  }
};

// ==========================================
// 7. [GET] Lấy danh sách thành viên của nhóm
// ==========================================
exports.getMembers = async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const result = await pool.query(
      `SELECT 
        u."Id", u."Name", u."Email", u."Phone", u."DOB", u."Gender", 
        u."CurrentTerm", u."AvatarUrl", u."MemberCode", u."StudentId",
        m."Name" as "MajorName", 
        uni."Name" as "UniversityName", 
        gm."GroupRole", gm."JoinedAt"
      FROM "Users" u
      JOIN "GroupMembers" gm ON u."Id" = gm."UserId"
      LEFT JOIN "Majors" m ON u."MajorId" = m."Id"
      LEFT JOIN "Universities" uni ON u."UniversityId" = uni."Id"
      WHERE gm."GroupId" = $1
      ORDER BY 
        CASE gm."GroupRole" 
          WHEN 'Leader' THEN 1 
          WHEN 'Action Leader' THEN 2 
          ELSE 3 
        END, u."Name" ASC`,
      [groupId],
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server khi lấy thành viên." });
  }
};

// ==========================================
// 8. [POST] Gửi thông báo tức thì (Nhắc nhở)
// ==========================================
exports.sendInstantNotification = async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { type, notifyForm } = req.body;

    const sendEmail =
      req.body.sendEmail === true || req.body.sendEmail === "true";
    const emailNote = req.body.emailNote || "";
    const title = notifyForm?.title || "Thông báo nhóm";
    const message =
      notifyForm?.message ||
      (type === "reminder"
        ? "Leader vừa gửi một lời nhắc nhở quan trọng!"
        : "Thông báo mới từ Leader!");

    const memberIds = await getGroupMemberIds(groupId);
    await createNotifications({
      userIds: memberIds,
      title,
      message,
      type: "system",
      category: "group",
      groupId,
      senderId: req.user.id,
      skipSelf: true,
    });

    if (sendEmail) {
      const senderRes = await pool.query(
        `SELECT "Name" FROM "Users" WHERE "Id" = $1`,
        [req.user.id],
      );
      const senderName = senderRes.rows[0]?.Name || "Leader";
      const groupUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/group/${groupId}`;

      emailService.sendGroupAnnouncementEmail({
        groupId,
        title,
        message,
        senderName,
        note: emailNote || undefined,
        groupUrl,
      });
    }

    res
      .status(200)
      .json({ success: true, message: "Đã gửi thông báo thành công!" });
  } catch (error) {
    console.error("Lỗi sendInstantNotification:", error);
    res.status(500).json({ success: false, message: "Lỗi khi gửi thông báo." });
  }
};

// ==========================================
// 9. [PUT] Cập nhật mô tả nhóm + Giảng viên
// ==========================================
exports.updateGroupDescription = async (req, res) => {
  try {
    const groupId = req.params.groupId || req.params.id;
    const desc = req.body.description || req.body.Description || "";
    const lecId = req.body.lecturerId || req.body.LecturerId || null;

    await pool.query(
      `
      UPDATE "Groups" SET "Description" = $1, "LecturerId" = $2 WHERE "Id" = $3
    `,
      [desc, lecId, groupId],
    );

    res
      .status(200)
      .json({ success: true, message: "Cập nhật thông tin nhóm thành công!" });
  } catch (err) {
    console.error("Lỗi cập nhật thông tin nhóm:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server khi cập nhật" });
  }
};

// ==========================================
// 10. [GET] Lấy chi tiết nhóm (Kèm kiểm tra thành viên)
// ==========================================
exports.getGroupById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id || req.user.Id || req.userId;

    // Kiểm tra quyền truy cập (Chỉ cho phép member hoặc admin)
    const memberCheck = await pool.query(
      `SELECT 1 FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [id, userId],
    );
    const sysRole = (req.user.role || "").toLowerCase();

    if (memberCheck.rows.length === 0 && sysRole !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Bạn không phải thành viên nhóm này!",
      });
    }

    const groupRes = await pool.query(
      `
      SELECT 
        g.*, s."SubjectName", s."SubjectNameVN", l."Name" AS "LecturerName",
        l."Email" AS "LecturerEmail", l."LecturerCode" AS "LecturerCode"
      FROM "Groups" g
      LEFT JOIN "Subjects" s ON g."SubjectCode" = s."SubjectCode"
      LEFT JOIN "Lecturers" l ON g."LecturerId" = l."Id"
      WHERE g."Id" = $1
    `,
      [id],
    );

    if (groupRes.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không thấy nhóm" });
    }

    const membersRes = await pool.query(
      `
      SELECT 
        u."Id", u."Name", u."Email", u."Phone", u."DOB", u."Gender", 
        u."CurrentTerm", u."MemberCode", u."StudentId", u."AvatarUrl",
        u."MajorId", u."UniversityId", m."Name" as "MajorName", 
        uni."Name" as "UniversityName", gm."GroupRole", gm."JoinedAt"
      FROM "GroupMembers" gm
      JOIN "Users" u ON gm."UserId" = u."Id"
      LEFT JOIN "Majors" m ON u."MajorId" = m."Id"
      LEFT JOIN "Universities" uni ON u."UniversityId" = uni."Id"
      WHERE gm."GroupId" = $1
    `,
      [id],
    );

    res.json({
      success: true,
      group: groupRes.rows[0],
      members: membersRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// ==========================================
// 11. [POST] Duyệt đơn
// ==========================================
exports.approveGroupRequest = async (req, res) => {
  const client = await pool.connect();
  try {
    const { requestId } = req.params;
    const { isApproved, adminNote } = req.body;

    await client.query("BEGIN");
    const requestRes = await client.query(
      `SELECT * FROM "GroupRequests" WHERE "Id" = $1`,
      [requestId],
    );
    const groupReq = requestRes.rows[0];

    if (!groupReq || groupReq.Status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Đơn không tồn tại hoặc đã được xử lý",
      });
    }

    if (isApproved) {
      const insertGroup = await client.query(
        `
        INSERT INTO "Groups" ("Name", "SubjectCode", "ClassName", "Semester", "GroupNumber", "Description")
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING "Id"
      `,
        [
          groupReq.GroupName,
          groupReq.SubjectCode,
          groupReq.ClassName,
          groupReq.Semester,
          groupReq.GroupNumber,
          groupReq.Description,
        ],
      );

      const newGroupId = insertGroup.rows[0].Id;

      await client.query(
        `
        INSERT INTO "GroupMembers" ("GroupId", "UserId", "GroupRole") VALUES ($1, $2, 'Leader')
      `,
        [newGroupId, groupReq.CreatedBy],
      );

      if (groupReq.MemberEmails) {
        try {
          const emails = JSON.parse(groupReq.MemberEmails);
          if (Array.isArray(emails)) {
            for (const email of emails) {
              if (!email) continue;
              const userRes = await client.query(
                `SELECT "Id" FROM "Users" WHERE "Email" = $1`,
                [email],
              );
              if (userRes.rows.length > 0) {
                const memberId = userRes.rows[0].Id;
                if (memberId !== groupReq.CreatedBy) {
                  await client.query(
                    `
                    INSERT INTO "GroupMembers" ("GroupId", "UserId", "GroupRole") VALUES ($1, $2, 'User')
                  `,
                    [newGroupId, memberId],
                  );
                }
              }
            }
          }
        } catch (parseErr) {
          console.error("Lỗi parse MemberEmails JSON:", parseErr);
        }
      }
    }

    const newStatus = isApproved ? "approved" : "rejected";
    await client.query(
      `
        UPDATE "GroupRequests" SET "Status" = $1, "AdminNote" = $2, "UpdatedAt" = NOW() WHERE "Id" = $3
      `,
      [newStatus, adminNote || "", requestId],
    );

    await client.query("COMMIT");
    res.json({
      success: true,
      message: `Đã ${isApproved ? "duyệt" : "từ chối"} nhóm thành công!`,
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error("Lỗi duyệt nhóm:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 12. [GET] Lấy Tasks của Member Trong Nhóm
// ==========================================
exports.getMemberTasksInGroup = async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    const result = await pool.query(
      `
      SELECT 
        ta."Id" AS "AssignmentId", ta."Viewed", ta."Completed", ta."Note",
        t."Id" AS "TaskId", t."Content", t."TaskCode", t."Deadline", t."Status"
      FROM "TaskAssignments" ta
      JOIN "Tasks" t ON ta."TaskId" = t."Id"
      WHERE t."GroupId" = $1 AND ta."UserId" = $2
      ORDER BY t."Deadline" DESC
    `,
      [groupId, userId],
    );

    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Lỗi lấy task của member:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi máy chủ khi lấy nhiệm vụ!" });
  }
};

// ==========================================
// 13. [DELETE] Rời nhóm (Chuyển từ Route sang)
// ==========================================
exports.leaveGroup = async (req, res) => {
  try {
    const userId = req.user.id || req.user.Id;
    const { groupId } = req.params;

    await pool.query(
      `DELETE FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [groupId, userId],
    );
    res.json({ success: true, message: "Đã rời nhóm thành công" });
  } catch (error) {
    console.error("Lỗi rời nhóm:", error);
    res.status(500).json({ success: false, message: "Lỗi khi rời nhóm" });
  }
};
// [GET] Lấy thống kê tổng quan cho Leader
exports.getLeaderStats = async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);

    const [memberRes, taskRes, notifRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM "GroupMembers" WHERE "GroupId" = $1`, [
        groupId,
      ]),
      pool.query(
        `SELECT * FROM "Tasks" WHERE "GroupId" = $1 ORDER BY "Deadline" ASC`,
        [groupId],
      ),
      pool.query(
        `
  SELECT * FROM "Notifications"
  WHERE "GroupId" = $1
  ORDER BY "CreatedAt" DESC LIMIT 10
`,
        [groupId],
      ),
    ]);

    const tasks = taskRes.rows;
    const upcomingTasks = tasks
      .filter(
        (t) =>
          t.Status !== "completed" && t.Status !== "cancelled" && t.Deadline,
      )
      .sort((a, b) => new Date(a.Deadline) - new Date(b.Deadline))
      .slice(0, 5);

    res.json({
      success: true,
      stats: {
        memberCount: parseInt(memberRes.rows[0].count),
        taskCount: tasks.length,
        upcomingTasks,
      },
      notifications: notifRes.rows,
    });
  } catch (err) {
    console.error("Lỗi getLeaderStats:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};
// [GET] Lấy tài liệu của nhóm
exports.getGroupResources = async (req, res) => {
  try {
    const groupId = req.params.groupId;

    // Lấy SubjectCode của nhóm
    const groupRes = await pool.query(
      `SELECT "SubjectCode" FROM "Groups" WHERE "Id" = $1`,
      [groupId],
    );
    const subjectCode = groupRes.rows[0]?.SubjectCode;

    if (!subjectCode) {
      return res.json({ success: true, folders: [], files: [] });
    }

    // Lấy folders theo SubjectCode
    const foldersRes = await pool.query(
      `SELECT * FROM "ResourceFolders" WHERE "SubjectCode" = $1 ORDER BY "CreatedAt" DESC`,
      [subjectCode],
    );

    // Lấy files trong các folder đó
    const filesRes = await pool.query(
      `SELECT f.*, u."Name" AS "UploaderName", rf."Name" AS "FolderName"
       FROM "ResourceFiles" f
       JOIN "ResourceFolders" rf ON f."FolderId" = rf."Id"
       LEFT JOIN "Users" u ON f."AddedBy" = u."Id"
       WHERE rf."SubjectCode" = $1
       ORDER BY f."CreatedAt" DESC`,
      [subjectCode],
    );

    res.json({ success: true, folders: foldersRes.rows, files: filesRes.rows });
  } catch (err) {
    console.error("Lỗi getGroupResources:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};
// [PUT] Cập nhật các link liên kết nhóm
exports.updateGroupLinks = async (req, res) => {
  try {
    const groupId = req.params.groupId || req.params.id;
    const {
      ZaloLink,
      StudyMaterialLink,
      GithubLink,
      GitlabLink,
      OtherLink1,
      OtherLink2,
    } = req.body;

    await pool.query(
      `
      UPDATE "Groups"
      SET "ZaloLink" = $1, "StudyMaterialLink" = $2, "GithubLink" = $3,
          "GitlabLink" = $4, "OtherLink1" = $5, "OtherLink2" = $6
      WHERE "Id" = $7
    `,
      [
        ZaloLink || null,
        StudyMaterialLink || null,
        GithubLink || null,
        GitlabLink || null,
        OtherLink1 || null,
        OtherLink2 || null,
        groupId,
      ],
    );

    res.json({ success: true, message: "Cập nhật liên kết thành công!" });
  } catch (err) {
    console.error("Lỗi updateGroupLinks:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};
// ==========================================
// 14. [PUT] Đổi vai trò thành viên
// ==========================================
exports.updateMemberRole = async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    const { role } = req.body;

    const validRoles = ["User", "Action Leader", "Leader"];
    const normalizedRole = validRoles.find(
      (r) => r.toLowerCase() === role?.toLowerCase(),
    );
    if (!normalizedRole) {
      return res
        .status(400)
        .json({ success: false, message: "Vai trò không hợp lệ!" });
    }

    // Nếu chuyển thành Leader → hạ Leader cũ xuống User
    if (normalizedRole === "Leader") {
      await pool.query(
        `UPDATE "GroupMembers" SET "GroupRole" = 'User'
         WHERE "GroupId" = $1 AND "GroupRole" = 'Leader'`,
        [groupId],
      );
    }

    await pool.query(
      `UPDATE "GroupMembers" SET "GroupRole" = $1
       WHERE "GroupId" = $2 AND "UserId" = $3`,
      [normalizedRole, groupId, userId],
    );

    res.json({ success: true, message: "Cập nhật vai trò thành công!" });
  } catch (err) {
    console.error("Lỗi updateMemberRole:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};

// ==========================================
// 15. [DELETE] Leader xóa thành viên khỏi nhóm
// ==========================================
exports.removeMember = async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    await pool.query(
      `DELETE FROM "GroupMembers" WHERE "GroupId" = $1 AND "UserId" = $2`,
      [groupId, userId],
    );
    res.json({ success: true, message: "Đã xóa thành viên khỏi nhóm!" });
  } catch (err) {
    console.error("Lỗi removeMember:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
};
