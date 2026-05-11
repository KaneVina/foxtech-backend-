// ═══════════════════════════════════════════════════════════════
// deadlineChecker.js
// Cron job tự động:
//   1. Gửi nhắc nhở khi deadline đến gần (3 ngày + 1 ngày trước)
//   2. Ghi nhận overdue log khi quá hạn chưa hoàn thành
//   3. Gửi notification + email tự động
//
// CÁCH CÀI ĐẶT:
//   npm install node-cron
//
// CÁCH SỬ DỤNG — trong file server.js (hoặc app.js) thêm:
//   require("./jobs/deadlineChecker");
//
// Đặt file này tại: src/jobs/deadlineChecker.js
// ═══════════════════════════════════════════════════════════════

const cron = require("node-cron");
const { pool } = require("../config/db");
const emailService = require("../utils/emailService");
const { createNotifications } = require("../utils/notificationHelper");

// ── Cấu hình ngưỡng nhắc ──────────────────────────────────────
const REMIND_DAYS = [3, 1]; // Nhắc khi còn 3 ngày VÀ 1 ngày trước deadline
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ─────────────────────────────────────────────────────────────
// HELPER: Lấy ngày hôm nay dạng YYYY-MM-DD (không tạo Date object)
// ─────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

// ─────────────────────────────────────────────────────────────
// JOB 1: Nhắc nhở deadline sắp đến
// Chạy: Hàng ngày lúc 08:00 sáng
// Logic:
//   - Tìm UC/Issue có DueDate = hôm nay + N (N ∈ REMIND_DAYS)
//   - Status chưa Hoàn thành/Tạm miễn
//   - Chưa gửi nhắc trong vòng 20 tiếng (tránh spam)
// ─────────────────────────────────────────────────────────────
async function runDeadlineReminder() {
  console.log("[DeadlineChecker] Bắt đầu kiểm tra deadline nhắc nhở...");
  const now = new Date();

  for (const daysLeft of REMIND_DAYS) {
    const targetDate = addDays(todayStr(), daysLeft);

    // ── Kiểm tra ProjectSchedules ──────────────────────────
    try {
      const schedules = await sql.query`
        SELECT ps.Id, ps.UCID, ps.TaskTitle, ps.DueDate, ps.OwnerId,
               ps.TaskId, t.GroupId
        FROM ProjectSchedules ps
        JOIN Tasks t ON ps.TaskId = t.Id
        WHERE CONVERT(date, ps.DueDate) = ${targetDate}
          AND ps.Status NOT IN (N'Hoàn thành', N'Tạm miễn')
          AND ps.OwnerId IS NOT NULL
          AND (
            ps.ReminderSentAt IS NULL
            OR DATEDIFF(HOUR, ps.ReminderSentAt, NOW()) >= 20
          )
      `;

      for (const sc of schedules.recordset) {
        const taskUrl = `${FRONTEND_URL}/group/${sc.GroupId}/task/${sc.TaskId}`;
        const title   = `Sắp đến hạn (còn ${daysLeft} ngày): ${sc.UCID}`;
        const message = `UC <strong>${sc.UCID} — ${sc.TaskTitle}</strong> sẽ hết hạn vào <strong>${targetDate}</strong>. Hãy hoàn thành đúng hạn!`;

        // Notification realtime
        await createNotifications({
          userIds: [sc.OwnerId],
          title,
          message,
          type: "alert",
          category: "task",
          groupId: sc.GroupId,
          senderId: null,
          referenceId: sc.TaskId,
          skipSelf: false,
        });

        // Email
        emailService.sendDeadlineReminderEmail({
          userId: sc.OwnerId,
          taskTitle: `${sc.UCID} — ${sc.TaskTitle}`,
          dueDate: targetDate,
          groupId: sc.GroupId,
          taskUrl,
        });

        // Cập nhật ReminderSentAt
        await sql.query`
          UPDATE ProjectSchedules
          SET ReminderSentAt = NOW()
          WHERE Id = ${sc.Id}
        `;

        console.log(`[DeadlineChecker] Đã nhắc UC ${sc.UCID} (còn ${daysLeft} ngày)`);
      }
    } catch (err) {
      console.error("[DeadlineChecker] Lỗi schedule reminder:", err.message);
    }

    // ── Kiểm tra IssueTrackings ────────────────────────────
    try {
      const issues = await sql.query`
        SELECT it.Id, it.DefectId, it.Description, it.DueDate,
               it.TaskId, ps.OwnerId,
               t.GroupId
        FROM IssueTrackings it
        JOIN Tasks t ON it.TaskId = t.Id
        LEFT JOIN ProjectSchedules ps ON it.ProjectScheduleId = ps.Id
        WHERE CONVERT(date, it.DueDate) = ${targetDate}
          AND it.Status NOT IN (N'Hoàn thành', N'Tạm miễn')
          AND ps.OwnerId IS NOT NULL
          AND (
            it.ReminderSentAt IS NULL
            OR DATEDIFF(HOUR, it.ReminderSentAt, NOW()) >= 20
          )
      `;

      for (const iss of issues.recordset) {
        const taskUrl = `${FRONTEND_URL}/group/${iss.GroupId}/task/${iss.TaskId}`;
        const desc60  = iss.Description?.substring(0, 60) || "";
        const title   = `Sắp đến hạn Issue (còn ${daysLeft} ngày): ${iss.DefectId}`;
        const message = `Issue <strong>${iss.DefectId}</strong> — ${desc60} sẽ hết hạn vào <strong>${targetDate}</strong>.`;

        await createNotifications({
          userIds: [iss.OwnerId],
          title,
          message,
          type: "alert",
          category: "task",
          groupId: iss.GroupId,
          senderId: null,
          referenceId: iss.TaskId,
          skipSelf: false,
        });

        emailService.sendDeadlineReminderEmail({
          userId: iss.OwnerId,
          taskTitle: `Issue ${iss.DefectId}: ${desc60}`,
          dueDate: targetDate,
          groupId: iss.GroupId,
          taskUrl,
        });

        await sql.query`
          UPDATE IssueTrackings SET ReminderSentAt = NOW() WHERE Id = ${iss.Id}
        `;

        console.log(`[DeadlineChecker] Đã nhắc Issue ${iss.DefectId} (còn ${daysLeft} ngày)`);
      }
    } catch (err) {
      console.error("[DeadlineChecker] Lỗi issue reminder:", err.message);
    }
  }

  console.log("[DeadlineChecker] Nhắc nhở hoàn tất.");
}

// ─────────────────────────────────────────────────────────────
// JOB 2: Ghi nhận và thông báo items quá hạn
// Chạy: Hàng ngày lúc 00:30 sáng (sau nửa đêm)
// Logic:
//   - Tìm UC/Issue có DueDate < hôm nay, chưa Hoàn thành
//   - Chưa có OverdueLog cho item này
//   - Ghi OverdueLogs, set OverdueAt, gửi notification cho Leader
// ─────────────────────────────────────────────────────────────
async function runOverdueCheck() {
  console.log("[DeadlineChecker] Bắt đầu kiểm tra quá hạn...");
  const today = todayStr();

  // ── Overdue Schedules ──────────────────────────────────────
  try {
    const overdueSchedules = await sql.query`
      SELECT ps.Id, ps.UCID, ps.TaskTitle, ps.DueDate,
             ps.OwnerId, ps.TaskId, t.GroupId
      FROM ProjectSchedules ps
      JOIN Tasks t ON ps.TaskId = t.Id
      WHERE ps.DueDate::date < ${today}
        AND ps.Status NOT IN (N'Hoàn thành', N'Tạm miễn', N'Đình chỉ')
        AND ps.OwnerId IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM OverdueLogs
          WHERE ScheduleId = ps.Id AND HandledAt IS NULL
        )
    `;

    for (const sc of overdueSchedules.recordset) {
      const dueDateStr = sc.DueDate
        ? sc.DueDate.toString().split("T")[0]
        : today;

      // Ghi OverdueLog
      await sql.query`
        INSERT INTO OverdueLogs
          (TaskId, ItemType, ScheduleId, ItemTitle, ItemCode, OriginalDue, OverdueAt)
        VALUES
          (${sc.TaskId}, 'schedule', ${sc.Id},
           ${sc.TaskTitle}, ${sc.UCID}, ${dueDateStr}, NOW())
      `;

      // Update OverdueAt trên chính UC (nếu chưa set)
      await sql.query`
        UPDATE ProjectSchedules
        SET OverdueAt = NOW(), Status = N'Đình chỉ'
        WHERE Id = ${sc.Id} AND OverdueAt IS NULL
      `;

      // Thông báo Leader trong nhóm
      const leaderRes = await sql.query`
        SELECT UserId FROM GroupMembers
        WHERE GroupId = ${sc.GroupId}
          AND GroupRole IN (N'Leader', N'Action Leader')
      `;
      const leaderIds = leaderRes.recordset.map((r) => r.UserId);

      if (leaderIds.length > 0) {
        await createNotifications({
          userIds: leaderIds,
          title: `Quá hạn: ${sc.UCID}`,
          message: `UC <strong>${sc.UCID} — ${sc.TaskTitle}</strong> đã quá hạn (<strong>${dueDateStr}</strong>) và chưa hoàn thành. Vui lòng xem xét và xử lý.`,
          type: "alert",
          category: "task",
          groupId: sc.GroupId,
          senderId: null,
          referenceId: sc.TaskId,
          skipSelf: false,
        });
      }

      console.log(`[DeadlineChecker] Ghi nhận overdue: UC ${sc.UCID}`);
    }
  } catch (err) {
    console.error("[DeadlineChecker] Lỗi ghi overdue schedule:", err.message);
  }

  // ── Overdue Issues ─────────────────────────────────────────
  try {
    const overdueIssues = await sql.query`
      SELECT it.Id, it.DefectId, it.Description, it.DueDate,
             it.TaskId, ps.OwnerId, t.GroupId
      FROM IssueTrackings it
      JOIN Tasks t ON it.TaskId = t.Id
      LEFT JOIN ProjectSchedules ps ON it.ProjectScheduleId = ps.Id
      WHERE it.DueDate::date < ${today}
        AND it.Status NOT IN (N'Hoàn thành', N'Tạm miễn', N'Đình chỉ')
        AND NOT EXISTS (
          SELECT 1 FROM OverdueLogs
          WHERE IssueId = it.Id AND HandledAt IS NULL
        )
    `;

    for (const iss of overdueIssues.recordset) {
      const dueDateStr = iss.DueDate
        ? iss.DueDate.toString().split("T")[0]
        : today;
      const desc60 = iss.Description?.substring(0, 60) || "";

      await sql.query`
        INSERT INTO OverdueLogs
          (TaskId, ItemType, IssueId, ItemTitle, ItemCode, OriginalDue, OverdueAt)
        VALUES
          (${iss.TaskId}, 'issue', ${iss.Id},
           ${desc60}, ${iss.DefectId}, ${dueDateStr}, NOW())
      `;

      await sql.query`
        UPDATE IssueTrackings
        SET OverdueAt = NOW(), Status = N'Đình chỉ'
        WHERE Id = ${iss.Id} AND OverdueAt IS NULL
      `;

      if (iss.OwnerId) {
        const leaderRes = await sql.query`
          SELECT UserId FROM GroupMembers
          WHERE GroupId = ${iss.GroupId}
            AND GroupRole IN (N'Leader', N'Action Leader')
        `;
        const leaderIds = leaderRes.recordset.map((r) => r.UserId);
        if (leaderIds.length > 0) {
          await createNotifications({
            userIds: [...leaderIds, iss.OwnerId],
            title: `Quá hạn Issue: ${iss.DefectId}`,
            message: `Issue <strong>${iss.DefectId}</strong> — ${desc60} đã quá hạn (<strong>${dueDateStr}</strong>).`,
            type: "alert",
            category: "task",
            groupId: iss.GroupId,
            senderId: null,
            referenceId: iss.TaskId,
            skipSelf: false,
          });
        }
      }

      console.log(`[DeadlineChecker] Ghi nhận overdue: Issue ${iss.DefectId}`);
    }
  } catch (err) {
    console.error("[DeadlineChecker] Lỗi ghi overdue issue:", err.message);
  }

  console.log("[DeadlineChecker] Kiểm tra quá hạn hoàn tất.");
}

// ═══════════════════════════════════════════════════════════════
// ĐĂNG KÝ CRON JOBS
// ═══════════════════════════════════════════════════════════════

// Job 1: Nhắc deadline — 08:00 hàng ngày (múi giờ VN = UTC+7)
// Nếu server chạy UTC: dùng "0 1 * * *" (01:00 UTC = 08:00 VN)
// Nếu server chạy UTC+7: dùng "0 8 * * *"
const reminderSchedule =
  process.env.TIMEZONE === "Asia/Ho_Chi_Minh" ? "0 8 * * *" : "0 1 * * *";

cron.schedule(reminderSchedule, async () => {
  try {
    await runDeadlineReminder();
  } catch (err) {
    console.error("[DeadlineChecker][CRON] Lỗi reminder job:", err.message);
  }
});

// Job 2: Kiểm tra overdue — 00:30 hàng ngày
// Nếu server UTC: "30 17 * * *" (17:30 UTC = 00:30+1 VN)
// Nếu server UTC+7: "30 0 * * *"
const overdueSchedule =
  process.env.TIMEZONE === "Asia/Ho_Chi_Minh" ? "30 0 * * *" : "30 17 * * *";

cron.schedule(overdueSchedule, async () => {
  try {
    await runOverdueCheck();
  } catch (err) {
    console.error("[DeadlineChecker][CRON] Lỗi overdue job:", err.message);
  }
});

console.log("[DeadlineChecker] Cron jobs đã đăng ký:");
console.log(`  → Nhắc deadline: ${reminderSchedule}`);
console.log(`  → Kiểm tra overdue: ${overdueSchedule}`);

// Xuất để test thủ công (nếu cần)
module.exports = { runDeadlineReminder, runOverdueCheck };