// ═══════════════════════════════════════════════════════════════
// emailService.js  —  FoxTech Academic Email System
// Template: Academic Announcement (email.html design)
// Logo: Cloudinary CDN
// ═══════════════════════════════════════════════════════════════
const { Resend } = require("resend");
const { pool } = require("../config/db");

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || "FoxTech <noreply@foxtech.edu.vn>";

// ─── Logo URLs ────────────────────────────────────────────────
const LOGO_HEADER =
  "https://res.cloudinary.com/depz8k6gz/image/upload/v1777921846/logoLogin_v6dqfi.png"; // Header: logo hình chữ nhật, filter trắng
const LOGO_FOOTER =
  "https://res.cloudinary.com/depz8k6gz/image/upload/v1777950562/Black_and_Blue_Modern_Technology_Presentation_2_qzazrb.png"; // Footer: logo mờ nền tối
const LOGO_ICON =
  "https://res.cloudinary.com/depz8k6gz/image/upload/v1777950562/Black_and_Blue_Modern_Technology_Presentation_qtxjdg.png"; // Signature: icon hình vuông    // Signature: icon hình vuông

// ─── DB Helpers ───────────────────────────────────────────────
async function getGroupMemberEmails(groupId) {
  const res = await pool.query(
    `SELECT u."Email", u."Name" FROM "Users" u
     JOIN "GroupMembers" gm ON u."Id" = gm."UserId"
     WHERE gm."GroupId" = $1
       AND u."Email" IS NOT NULL AND u."Email" != ''`,
    [groupId],
  );
  return res.rows;
}

async function getUserEmail(userId) {
  const res = await pool.query(
    `SELECT "Email", "Name" FROM "Users" WHERE "Id" = $1`,
    [userId],
  );
  return res.rows[0] || null;
}

async function getGroupName(groupId) {
  const res = await pool.query(`SELECT "Name" FROM "Groups" WHERE "Id" = $1`, [
    groupId,
  ]);
  return res.rows[0]?.Name || "Nhóm học tập";
}

function formatSentAt() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())} · ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ═══════════════════════════════════════════════════════════════
// RENDER EMAIL — Theo đúng design email.html
// Dùng table-based inline style để tương thích Gmail/Outlook
// ═══════════════════════════════════════════════════════════════
function renderEmail({
  subject, // V/v dòng tiêu đề
  recipientName, // Tên người nhận (optional)
  bodyHtml, // Nội dung HTML chính
  ctaText, // Text nút bấm (optional)
  ctaUrl, // URL nút bấm (optional)
  senderName, // Tên người gửi
  senderRole, // Chức vụ
  senderEmail, // Email người gửi
  senderPhone, // SĐT (optional)
  // backward compat
  title,
  note,
}) {
  const vv = subject || title || "Thông báo từ hệ thống";
  const salute = recipientName
    ? `Kính gửi: <strong style="font-weight:600;color:#111827;">Anh/Chị ${recipientName}</strong>,`
    : `Kính gửi: <strong style="font-weight:600;color:#111827;">Toàn thể thành viên</strong>,`;
  const sentAt = formatSentAt();

  const ctaBlock =
    ctaText && ctaUrl
      ? `
  <tr><td style="padding:0 52px 28px;text-align:center;">
    <a href="${ctaUrl}"
       style="display:inline-block;padding:13px 38px;border-radius:8px;
              background:#4b46e5;color:#ffffff;font-family:Arial,sans-serif;
              font-size:13px;font-weight:600;letter-spacing:0.05em;
              text-decoration:none;">
      ${ctaText} &nbsp;→
    </a>
  </td></tr>`
      : "";

  const noteBlock = note
    ? `
  <div style="padding:14px 18px;margin:16px 0;
              background:rgba(75,70,229,0.06);
              border:1px solid rgba(75,70,229,0.15);
              border-left:3px solid #4b46e5;
              border-radius:0 8px 8px 0;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;
              color:#4b46e5;letter-spacing:0.08em;text-transform:uppercase;">
      Ghi chú từ ${senderName || "Leader"}
    </p>
    <p style="margin:0;font-size:14px;color:#374151;line-height:1.65;">
      ${note}
    </p>
  </div>`
    : "";

  const phoneRow = senderPhone
    ? `
    <tr>
      <td style="padding:2px 0;font-size:12px;color:#6b7280;vertical-align:middle;">
        <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTEiIGhlaWdodD0iMTEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNmI3MjgwIiBzdHJva2Utd2lkdGg9IjEuNSI+PHBhdGggZD0iTTIyIDE2LjkydjNhMiAyIDAgMDEtMi4xOCAyIDE5Ljc5IDE5Ljc5IDAgMDEtOC42My0zLjA3QTE5LjUgMTkuNSAwIDAwMy4wNyA5LjhhMTkuNzkgMTkuNzkgMCAwMS0zLjA3LTguNjNBMiAyIDAgMDEyIDBoM2EyIDIgMCAwMTIgMS43MmMuMTI3Ljk2LjM2MSAxLjkwMy43IDIuODFhMiAyIDAgMDEtLjQ1IDIuMTFMNi4wOSA3LjkxYTE2IDE2IDAgMDA2IDZsMS4yNy0xLjI3YTIgMiAwIDAxMi4xMS0uNDVjLjkwNy4zMzkgMS44NS41NzMgMi44MS43QTIgMiAwIDAxMjIgMTQuOTJ2MnoiLz48L3N2Zz4="
             width="11" height="11" style="vertical-align:middle;margin-right:5px;opacity:0.5;"/>
        SĐT: ${senderPhone}
      </td>
    </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${vv}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings>
    <o:PixelsPerInch>96</o:PixelsPerInch>
  </o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    @media (prefers-color-scheme: dark) {
      .ef-bg  { background-color: #040408 !important; }
      .ef-copy { color: rgba(255,255,255,0.15) !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#eef0f7;
             font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;">

<!-- Outer wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" role="presentation"
       style="background:#eef0f7;padding:40px 16px;">
  <tr><td align="center">

  <!-- Email card -->
  <table width="640" cellpadding="0" cellspacing="0" role="presentation"
         style="max-width:640px;width:100%;background:#ffffff;
                border-radius:10px;overflow:hidden;
                border:1px solid #e5e7eb;
                box-shadow:0 24px 60px rgba(75,70,229,0.12),0 4px 20px rgba(0,0,0,0.07);">

    <!-- ═══ HEADER ═══ -->
    <tr>
      <td style="background:#0b0b14;padding:0;border-radius:10px 10px 0 0;">
        <!-- Top accent line -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td style="height:2px;
                       background:linear-gradient(90deg,transparent,#4b46e5 25%,#6366f1 75%,transparent);
                       font-size:0;line-height:0;">&nbsp;</td>
          </tr>
        </table>
        <!-- Logo row -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td align="center" style="padding:20px 40px 22px;">
              <img src="${LOGO_HEADER}"
                   alt="FoxTech"
                   width="200"
                   style="height:36px;max-width:240px;
                          display:block;border:0;
                          filter:brightness(0) invert(1);"/>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ═══ SUBJECT BAND ═══ -->
    <tr>
      <td style="background:#ffffff;padding:26px 52px 24px;
                 text-align:center;border-bottom:1px solid #e5e7eb;">
        <!-- Academic Announcement (nhỏ) -->
        <p style="margin:0 0 7px;font-size:9px;font-weight:500;
                  letter-spacing:0.28em;text-transform:uppercase;
                  color:#9ca3af;font-family:Arial,sans-serif;">
          Academic Announcement
        </p>
        <!-- THÔNG BÁO HỌC VỤ (lớn, in hoa) -->
        <p style="margin:0;font-size:21px;font-weight:700;
                  letter-spacing:0.06em;
                  color:#111827;line-height:1.15;font-family:Arial,sans-serif;">
          THÔNG BÁO <span style="color:#4b46e5;">HỌC VỤ</span>
        </p>
        <!-- Divider + badge -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
               style="margin:16px 0;">
          <tr>
            <td style="height:1px;background:#e5e7eb;font-size:0;">&nbsp;</td>
            <td style="white-space:nowrap;padding:0 12px;">
              <span style="display:inline-block;padding:3px 14px;
                           border-radius:100px;
                           border:1px solid rgba(75,70,229,0.2);
                           background:rgba(75,70,229,0.07);
                           font-size:10px;font-weight:600;
                           color:#4b46e5;letter-spacing:0.08em;
                           text-transform:uppercase;
                           font-family:Arial,sans-serif;">
                &#9679;&nbsp; Thông báo
              </span>
            </td>
            <td style="height:1px;background:#e5e7eb;font-size:0;">&nbsp;</td>
          </tr>
        </table>
        <!-- V/v -->
        <p style="margin:0 0 7px;font-size:11px;font-weight:500;
                  color:#9ca3af;font-family:Arial,sans-serif;">V/v:</p>
        <p style="margin:0;font-size:15px;font-weight:600;
                  color:#111827;line-height:1.55;font-family:Arial,sans-serif;">
          ${vv}
        </p>
      </td>
    </tr>

    <!-- ═══ BODY ═══ -->
    <tr>
      <td style="padding:40px 52px 0;">
        <!-- Salute box -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
               style="margin-bottom:22px;">
          <tr>
            <td style="padding:13px 18px;
                       background:rgba(75,70,229,0.07);
                       border:1px solid rgba(75,70,229,0.15);
                       border-left:3px solid #4b46e5;
                       border-radius:0 8px 8px 0;
                       font-size:14px;color:#374151;line-height:1.65;
                       font-family:Arial,sans-serif;">
              ${salute}
            </td>
          </tr>
        </table>
        <!-- Body content -->
        <div style="font-size:14px;color:#374151;line-height:1.85;
                    font-family:Arial,sans-serif;">
          ${bodyHtml}
        </div>
        ${noteBlock}
      </td>
    </tr>

    <!-- CTA -->
    ${ctaBlock}

    <!-- ═══ SIGNATURE ═══ -->
    <tr>
      <td style="padding:0 52px 46px;">
        <!-- Divider -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
               style="border-top:1px solid #e5e7eb;margin-top:28px;padding-top:26px;">
          <tr>
            <td style="padding-top:26px;">
              <p style="margin:0 0 16px;font-size:14px;font-style:italic;
                        color:#6b7280;font-family:Arial,sans-serif;">Trân trọng,</p>
              <!-- Sig block -->
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <!-- Icon vuông -->
                  <td valign="top" style="width:64px;">
                    <table cellpadding="0" cellspacing="0" role="presentation"
                          style="width:64px;height:64px;border-radius:10px;
       background:rgba(75,70,229,0.18);
                                  overflow:hidden;">
                      <tr>
                        <td align="center" valign="middle" style="width:64px;height:64px;">
                          <img src="${LOGO_ICON}"
                               alt="logo" width="50" height="50"
                               style="width:50px;height:50px;object-fit:contain;
                                      display:block;border:0;"/>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <!-- Đường kẻ dọc -->
                  <td style="width:18px;font-size:0;">&nbsp;</td>
<td style="width:1px;background:#e5e7eb;font-size:0;line-height:0;">&nbsp;</td>
<td style="width:18px;font-size:0;">&nbsp;</td>
                  <!-- Info -->
                  <td valign="top" style="padding-left:18px;">
                    <table cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding-bottom:2px;font-size:15px;font-weight:700;
                                   color:#111827;font-family:Arial,sans-serif;">
                          ${senderName || "Hệ thống FoxTech"}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom:5px;font-size:12px;font-weight:500;
                                   color:#4b46e5;font-family:Arial,sans-serif;">
                          ${senderRole || ""}
                        </td>
                      </tr>
                      <tr>
                        <td style="font-size:12px;color:#6b7280;padding-bottom:2px;
                                   font-family:Arial,sans-serif;">
                          Email: ${senderEmail || "noreply@foxtech.edu.vn"}
                        </td>
                      </tr>
                      ${phoneRow}
                      <tr>
                        <td style="padding-top:7px;border-top:1px dashed #e5e7eb;
                                   font-size:11px;color:#9ca3af;
                                   font-family:Arial,sans-serif;">
                          Gửi tự động lúc ${sentAt}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ═══ FOOTER ═══ -->
    <tr>
      <td class="ef-bg"
          style="background:#080810;padding:28px 52px 32px;
                 text-align:center;border-radius:0 0 10px 10px;">
        <!-- Logo -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
               style="margin-bottom:16px;padding-bottom:16px;
                      border-bottom:1px solid rgba(255,255,255,0.06);">
          <tr>
            <td align="center">
              <img src="${LOGO_FOOTER}"
                   alt="FoxTech"
                   width="140"
                   style="height:22px;max-width:160px;object-fit:contain;
                          display:block;border:0;
                          filter:brightness(0) invert(0.5);"/>
            </td>
          </tr>
        </table>
        <!-- Links -->
        <p style="margin:0 0 14px;font-size:11px;
                  color:rgba(255,255,255,0.28);
                  font-family:Arial,sans-serif;">
          <a href="#" style="color:rgba(255,255,255,0.28);text-decoration:none;">Chính sách bảo mật</a>
          &nbsp;·&nbsp;
          <a href="#" style="color:rgba(255,255,255,0.28);text-decoration:none;">Điều khoản sử dụng</a>
          &nbsp;·&nbsp;
          <a href="#" style="color:rgba(255,255,255,0.28);text-decoration:none;">Liên hệ hỗ trợ</a>
          &nbsp;·&nbsp;
          <a href="#" style="color:rgba(255,255,255,0.28);text-decoration:none;">Hủy nhận thông báo</a>
        </p>
        <!-- Note VI -->
        <p style="margin:0 0 4px;font-size:12px;
                  color:rgba(255,255,255,0.3);line-height:1.7;
                  font-family:Arial,sans-serif;">
          Thư điện tử này được gửi tự động, vui lòng không phản hồi trực tiếp.
        </p>
        <!-- Note EN -->
        <p style="margin:0 0 14px;font-size:10px;
                  color:rgba(255,255,255,0.15);letter-spacing:0.04em;
                  font-family:Arial,sans-serif;">
          This email was sent automatically. Please do not reply directly to this message.
        </p>
        <!-- Copyright -->
        <p class="ef-copy"
           style="margin:0;font-size:11px;
                  color:rgba(255,255,255,0.18);
                  padding-top:12px;
                  border-top:1px solid rgba(255,255,255,0.06);
                  font-family:Arial,sans-serif;">
          ©2026 FoxTech. All rights reserved.
        </p>
      </td>
    </tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ─── Safe send ─────────────────────────────────────────────────
async function safeSend({ to, subject, html, tag }) {
  try {
    if (!to || (Array.isArray(to) && to.length === 0)) return;
    const recipients = Array.isArray(to) ? to : [to];
    const BATCH = 50;
    for (let i = 0; i < recipients.length; i += BATCH) {
      await resend.emails.send({
        from: FROM,
        to: recipients.slice(i, i + BATCH),
        subject,
        html,
        tags: tag ? [{ name: "event", value: tag }] : undefined,
      });
    }
    console.log(`[Email][${tag}] ✓ ${recipients.length} người`);
  } catch (err) {
    console.error(`[Email][${tag}] Lỗi:`, err?.message || err);
  }
}

// ═══════════════════════════════════════════════════════════════
// 1. Tạo Task → gửi toàn bộ nhóm
// ═══════════════════════════════════════════════════════════════
exports.sendTaskCreatedEmail = async ({
  groupId,
  taskTitle,
  taskDescription,
  assigneeName,
  dueDate,
  creatorName,
  creatorRole,
  creatorEmail,
  taskUrl,
  note,
}) => {
  try {
    const members = await getGroupMemberEmails(groupId);
    const groupName = await getGroupName(groupId);
    if (!members.length) return;

    const dueDateStr = dueDate
      ? new Date(dueDate).toLocaleDateString("vi-VN", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : null;

    const html = renderEmail({
      subject: `Nhiệm vụ mới: ${taskTitle}`,
      senderName: creatorName,
      senderRole: creatorRole || "Người tạo nhiệm vụ",
      senderEmail: creatorEmail || "",
      note,
      ctaText: "Xem chi tiết nhiệm vụ",
      ctaUrl: taskUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p><strong>${creatorName}</strong> vừa tạo một nhiệm vụ mới
        trong nhóm <strong>${groupName}</strong>.</p>

        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#f8fafc;border-radius:8px;
                      border:1px solid #e5e7eb;margin:16px 0;overflow:hidden;">
          <tr><td style="height:2px;background:linear-gradient(90deg,#4b46e5,#6366f1);font-size:0;">&nbsp;</td></tr>
          <tr><td style="padding:18px 20px;">
            <p style="margin:0 0 10px;font-size:16px;font-weight:700;color:#111827;font-family:Arial,sans-serif;">
              ${taskTitle}
            </p>
            ${taskDescription ? `<p style="margin:0 0 14px;font-size:13px;color:#6b7280;line-height:1.6;font-family:Arial,sans-serif;">${taskDescription}</p>` : ""}
            <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;">
              ${
                assigneeName
                  ? `
              <tr>
                <td style="padding:4px 0;font-size:12px;color:#9ca3af;width:120px;font-family:Arial,sans-serif;">Phụ trách</td>
                <td style="padding:4px 0;font-size:13px;font-weight:600;color:#374151;font-family:Arial,sans-serif;">${assigneeName}</td>
              </tr>`
                  : ""
              }
              ${
                dueDateStr
                  ? `
              <tr>
                <td style="padding:4px 0;font-size:12px;color:#9ca3af;font-family:Arial,sans-serif;">Deadline</td>
                <td style="padding:4px 0;font-size:13px;font-weight:600;color:#ef4444;font-family:Arial,sans-serif;">${dueDateStr}</td>
              </tr>`
                  : ""
              }
              <tr>
                <td style="padding:4px 0;font-size:12px;color:#9ca3af;font-family:Arial,sans-serif;">Nhóm</td>
                <td style="padding:4px 0;font-size:13px;font-weight:600;color:#374151;font-family:Arial,sans-serif;">${groupName}</td>
              </tr>
            </table>
          </td></tr>
        </table>
        <p style="font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
          Vui lòng đăng nhập hệ thống để xem chi tiết và cập nhật tiến độ.
        </p>`,
    });

    await safeSend({
      to: members.map((m) => m.Email).filter(Boolean),
      subject: `[${groupName}] Nhiệm vụ mới: ${taskTitle}`,
      html,
      tag: "task_created",
    });
  } catch (err) {
    console.error("[Email][task_created]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// 2. Thêm thành viên → gửi riêng người được thêm
// ═══════════════════════════════════════════════════════════════
exports.sendMemberAddedEmail = async ({
  userId,
  groupId,
  groupName,
  addedByName,
  addedByRole,
  addedByEmail,
  groupUrl,
}) => {
  try {
    const user = await getUserEmail(userId);
    if (!user?.Email) return;

    const html = renderEmail({
      subject: `Chào mừng tham gia nhóm ${groupName}`,
      recipientName: user.Name,
      senderName: addedByName,
      senderRole: addedByRole || "Leader",
      senderEmail: addedByEmail || "",
      ctaText: "Vào nhóm ngay",
      ctaUrl: groupUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p><strong>${addedByName}</strong> đã thêm bạn vào nhóm học tập
        <strong>${groupName}</strong>.</p>
        <p style="margin-top:12px;">Từ bây giờ bạn có thể xem nhiệm vụ, tài liệu và cộng tác
        cùng các thành viên khác trong nhóm. Nhấn nút bên dưới để bắt đầu.</p>`,
    });

    await safeSend({
      to: user.Email,
      subject: `Chào mừng gia nhập nhóm: ${groupName}`,
      html,
      tag: "member_added",
    });
  } catch (err) {
    console.error("[Email][member_added]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// 3. Thông báo nhóm (Leader gửi thủ công)
// ═══════════════════════════════════════════════════════════════
exports.sendGroupAnnouncementEmail = async ({
  groupId,
  title,
  message,
  senderName,
  senderRole,
  senderEmail,
  note,
  groupUrl,
}) => {
  try {
    const members = await getGroupMemberEmails(groupId);
    const groupName = await getGroupName(groupId);
    if (!members.length) return;

    const html = renderEmail({
      subject: title,
      senderName,
      senderRole: senderRole || "Leader",
      senderEmail: senderEmail || "",
      note,
      ctaText: groupUrl ? "Xem nhóm" : undefined,
      ctaUrl: groupUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p><strong>${senderName}</strong> — Leader nhóm <strong>${groupName}</strong>
        gửi thông báo:</p>
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#f8fafc;border-radius:8px;
                      border:1px solid #e5e7eb;margin:16px 0;">
          <tr><td style="padding:18px 20px;font-size:14px;color:#374151;
                          line-height:1.75;font-family:Arial,sans-serif;">
            ${message}
          </td></tr>
        </table>`,
    });

    await safeSend({
      to: members.map((m) => m.Email).filter(Boolean),
      subject: `[${groupName}] ${title}`,
      html,
      tag: "group_announcement",
    });
  } catch (err) {
    console.error("[Email][group_announcement]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// 4. Nhắc deadline
// ═══════════════════════════════════════════════════════════════
exports.sendDeadlineReminderEmail = async ({
  userId,
  taskTitle,
  dueDate,
  groupId,
  taskUrl,
}) => {
  try {
    const user = await getUserEmail(userId);
    if (!user?.Email) return;
    const groupName = await getGroupName(groupId);

    const dueDateStr = new Date(dueDate).toLocaleDateString("vi-VN", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const diff = Math.ceil((new Date(dueDate) - new Date()) / 86400000);

    const html = renderEmail({
      subject: `Nhắc nhở deadline: ${taskTitle}`,
      recipientName: user.Name,
      senderName: "Hệ thống FoxTech",
      senderRole: "Nhắc nhở tự động",
      senderEmail: "noreply@foxtech.edu.vn",
      ctaText: "Xem nhiệm vụ",
      ctaUrl: taskUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p>Nhiệm vụ <strong>${taskTitle}</strong> trong nhóm
        <strong>${groupName}</strong> sắp đến hạn.</p>
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#fef2f2;border-radius:8px;
                      border:1px solid #fca5a5;margin:16px 0;">
          <tr><td style="padding:16px 20px;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;
                      color:#991b1b;font-family:Arial,sans-serif;">
              ⚠ Deadline: ${dueDateStr}
            </p>
            <p style="margin:0;font-size:13px;color:#7f1d1d;
                      font-family:Arial,sans-serif;">
              Còn <strong>${diff} ngày</strong> — Hãy hoàn thành đúng hạn!
            </p>
          </td></tr>
        </table>`,
    });

    await safeSend({
      to: user.Email,
      subject: `[Deadline] ${taskTitle} — còn ${diff} ngày`,
      html,
      tag: "deadline_reminder",
    });
  } catch (err) {
    console.error("[Email][deadline_reminder]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// 5. Duyệt / Từ chối Code Push
// ═══════════════════════════════════════════════════════════════
exports.sendCodePushReviewEmail = async ({
  userId,
  groupId,
  action,
  ucid,
  ucTitle,
  rejectionNote,
  reviewerName,
  reviewerRole,
  reviewerEmail,
  pushUrl,
  note,
}) => {
  try {
    const user = await getUserEmail(userId);
    if (!user?.Email) return;
    const groupName = await getGroupName(groupId);
    const isApprove = action === "approve";

    const html = renderEmail({
      subject: isApprove
        ? `Code push đã được phê duyệt — ${ucid}`
        : `Code push bị từ chối — ${ucid}`,
      recipientName: user.Name,
      senderName: reviewerName,
      senderRole: reviewerRole || "Leader / Reviewer",
      senderEmail: reviewerEmail || "",
      note,
      ctaText: "Xem UC",
      ctaUrl: pushUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p><strong>${reviewerName}</strong> vừa
        ${isApprove ? "phê duyệt" : "từ chối"} code push của bạn
        trên UC <strong>${ucid} — ${ucTitle}</strong>
        thuộc nhóm <strong>${groupName}</strong>.</p>
        ${
          isApprove
            ? `
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#ecfdf5;border-radius:8px;
                      border:1px solid #6ee7b7;margin:16px 0;">
          <tr><td style="padding:14px 18px;font-size:14px;font-weight:600;
                          color:#065f46;font-family:Arial,sans-serif;">
            ✓ Gate 1 đã đạt. Hãy tiếp tục hoàn thiện tài liệu để UC được nghiệm thu.
          </td></tr>
        </table>`
            : `
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#fef2f2;border-radius:8px;
                      border:1px solid #fca5a5;margin:16px 0;">
          <tr><td style="padding:14px 18px;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;
                      color:#991b1b;text-transform:uppercase;
                      letter-spacing:0.06em;font-family:Arial,sans-serif;">
              Lý do từ chối
            </p>
            <p style="margin:0;font-size:14px;color:#7f1d1d;line-height:1.6;
                      font-family:Arial,sans-serif;">
              ${rejectionNote || "Không có lý do cụ thể."}
            </p>
          </td></tr>
        </table>
        <p style="font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
          UC đã reset về <strong>Chưa bắt đầu</strong>. Vui lòng khắc phục và nộp lại.
        </p>`
        }`,
    });

    await safeSend({
      to: user.Email,
      subject: isApprove
        ? `[Đã duyệt] Code push — ${ucid}: ${ucTitle}`
        : `[Từ chối] Code push — ${ucid}: ${ucTitle}`,
      html,
      tag: "code_push_review",
    });
  } catch (err) {
    console.error("[Email][code_push_review]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// 6. Duyệt / Yêu cầu chỉnh sửa Tài liệu
// ═══════════════════════════════════════════════════════════════
exports.sendDocumentReviewEmail = async ({
  createdById,
  groupId,
  action,
  ucid,
  ucTitle,
  docTitle,
  docType,
  rejectionNote,
  reviewerName,
  reviewerRole,
  reviewerEmail,
  docUrl,
  note,
}) => {
  try {
    const user = await getUserEmail(createdById);
    if (!user?.Email) return;
    const groupName = await getGroupName(groupId);
    const isApprove = action === "approve";

    const html = renderEmail({
      subject: isApprove
        ? `Tài liệu đã được phê duyệt`
        : `Tài liệu cần được chỉnh sửa`,
      recipientName: user.Name,
      senderName: reviewerName,
      senderRole: reviewerRole || "Leader / Reviewer",
      senderEmail: reviewerEmail || "",
      note,
      ctaText: "Xem tài liệu",
      ctaUrl: docUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p><strong>${reviewerName}</strong> vừa
        ${isApprove ? "phê duyệt" : "yêu cầu chỉnh sửa"}
        tài liệu của bạn trong nhóm <strong>${groupName}</strong>.</p>
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#f8fafc;border-radius:8px;
                      border:1px solid #e5e7eb;margin:16px 0;">
          <tr><td style="padding:16px 20px;">
            <p style="margin:0 0 4px;font-size:15px;font-weight:700;
                      color:#111827;font-family:Arial,sans-serif;">${docTitle}</p>
            <p style="margin:0;font-size:12px;color:#9ca3af;
                      font-family:Arial,sans-serif;">
              ${docType} · UC: ${ucid} — ${ucTitle}
            </p>
          </td></tr>
        </table>
        ${
          isApprove
            ? `
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#ecfdf5;border-radius:8px;
                      border:1px solid #6ee7b7;margin:16px 0;">
          <tr><td style="padding:14px 18px;font-size:14px;font-weight:600;
                          color:#065f46;font-family:Arial,sans-serif;">
            ✓ Tài liệu đã được xác nhận. Cảm ơn bạn đã hoàn thành đúng hạn!
          </td></tr>
        </table>`
            : `
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#fffbeb;border-radius:8px;
                      border:1px solid #fde68a;margin:16px 0;">
          <tr><td style="padding:14px 18px;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;
                      color:#92400e;text-transform:uppercase;
                      letter-spacing:0.06em;font-family:Arial,sans-serif;">
              Yêu cầu chỉnh sửa
            </p>
            <p style="margin:0;font-size:14px;color:#78350f;line-height:1.6;
                      font-family:Arial,sans-serif;">
              ${rejectionNote || "Vui lòng xem lại và chỉnh sửa tài liệu."}
            </p>
          </td></tr>
        </table>
        <p style="font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
          Tài liệu đã chuyển về <strong>Cần chỉnh sửa</strong>.
          Sau khi chỉnh xong, gửi lại để được phê duyệt.
        </p>`
        }`,
    });

    await safeSend({
      to: user.Email,
      subject: isApprove
        ? `[Đã duyệt] Tài liệu: ${docTitle} — ${ucid}`
        : `[Cần chỉnh sửa] Tài liệu: ${docTitle} — ${ucid}`,
      html,
      tag: "document_review",
    });
  } catch (err) {
    console.error("[Email][document_review]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// 7. UC hoàn thành → gửi toàn bộ nhóm
// ═══════════════════════════════════════════════════════════════
exports.sendUCCompletedEmail = async ({
  groupId,
  ucid,
  ucTitle,
  ownerName,
  taskUrl,
}) => {
  try {
    const members = await getGroupMemberEmails(groupId);
    const groupName = await getGroupName(groupId);
    if (!members.length) return;

    const html = renderEmail({
      subject: `UC hoàn thành: ${ucid} — ${ucTitle}`,
      senderName: "Hệ thống FoxTech",
      senderRole: "Tự động nghiệm thu",
      senderEmail: "noreply@foxtech.edu.vn",
      ctaText: "Xem UC",
      ctaUrl: taskUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p>UC <strong>${ucid} — ${ucTitle}</strong> thuộc nhóm
        <strong>${groupName}</strong> vừa vượt qua tất cả 3 cổng
        nghiệm thu và được xác nhận <strong>Hoàn thành</strong>.</p>
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;border-radius:8px;overflow:hidden;
                      border:1px solid #e5e7eb;margin:20px 0;">
          <tr><td colspan="2" style="height:2px;background:linear-gradient(90deg,#4b46e5,#6366f1);font-size:0;">&nbsp;</td></tr>
          ${[
            ["Gate 1 — Code Push", "Đã được phê duyệt"],
            ["Gate 2 — Issue", "Không còn lỗi mở"],
            ["Gate 3 — Tài liệu", "100% đã duyệt"],
          ]
            .map(
              ([label, val]) => `
          <tr>
            <td style="padding:11px 18px;border-bottom:1px solid #e5e7eb;
                       font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
              ${label}
            </td>
            <td style="padding:11px 18px;border-bottom:1px solid #e5e7eb;
                       font-size:13px;font-weight:700;color:#10b981;
                       text-align:right;font-family:Arial,sans-serif;">
              ✓ ${val}
            </td>
          </tr>`,
            )
            .join("")}
        </table>
        <p style="font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
          Phụ trách: <strong>${ownerName || "—"}</strong>
        </p>`,
    });

    await safeSend({
      to: members.map((m) => m.Email).filter(Boolean),
      subject: `[Hoàn thành] ${ucid} — ${ucTitle} · ${groupName}`,
      html,
      tag: "uc_completed",
    });
  } catch (err) {
    console.error("[Email][uc_completed]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// 8. Cảnh báo Nhóm (Group Warning)
// ═══════════════════════════════════════════════════════════════
exports.sendGroupWarningEmail = async ({ groupId, title, message }) => {
  try {
    const members = await getGroupMemberEmails(groupId);
    const groupName = await getGroupName(groupId);
    if (!members.length) return;

    const html = renderEmail({
      subject: `[CẢNH BÁO] ${title}`,
      senderName: "Hệ thống FoxTech",
      senderRole: "Quản trị viên",
      senderEmail: "admin@foxtech.edu.vn",
      bodyHtml: `
        <p>Hệ thống gửi một cảnh báo đến nhóm <strong>${groupName}</strong>:</p>
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#fffbeb;border-radius:8px;
                      border:1px solid #fde68a;margin:16px 0;">
          <tr><td style="padding:18px 20px;font-size:14px;color:#78350f;
                          line-height:1.75;font-family:Arial,sans-serif;">
            <strong>Nội dung:</strong><br/>
            ${message}
          </td></tr>
        </table>
        <p style="font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
          Vui lòng lưu ý và điều chỉnh để không ảnh hưởng đến tiến độ dự án.
        </p>`,
    });

    await safeSend({
      to: members.map((m) => m.Email).filter(Boolean),
      subject: `[${groupName}] CẢNH BÁO: ${title}`,
      html,
      tag: "group_warning",
    });
  } catch (err) {
    console.error("[Email][group_warning]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// 9. Thông báo Hệ thống (System Notification - Gửi All/User)
// ═══════════════════════════════════════════════════════════════
exports.sendSystemNotificationEmail = async ({ emails, title, message }) => {
  try {
    if (!emails || emails.length === 0) return;

    const html = renderEmail({
      subject: title,
      senderName: "Hệ thống FoxTech",
      senderRole: "Quản trị viên",
      senderEmail: "admin@foxtech.edu.vn",
      bodyHtml: `
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#f8fafc;border-radius:8px;
                      border:1px solid #e5e7eb;margin:16px 0;">
          <tr><td style="padding:18px 20px;font-size:14px;color:#374151;
                          line-height:1.75;font-family:Arial,sans-serif;">
            ${message}
          </td></tr>
        </table>`,
    });

    await safeSend({
      to: emails,
      subject: `[Thông báo Hệ thống] ${title}`,
      html,
      tag: "system_notification",
    });
  } catch (err) {
    console.error("[Email][system_notification]", err.message);
  }
};
// ═══════════════════════════════════════════════════════════════
// THÊM VÀO CUỐI FILE emailService.js
// Hàm gửi OTP đặt lại mật khẩu — dùng template renderEmail() hiện có
// ═══════════════════════════════════════════════════════════════

exports.sendOtpEmail = async ({ email, otp, userName }) => {
  try {
    const html = renderEmail({
      subject: "Mã OTP đặt lại mật khẩu",
      recipientName: userName || null,
      senderName: "Hệ thống FoxTech",
      senderRole: "Bảo mật tài khoản",
      senderEmail: "noreply@foxtech.edu.vn",
      bodyHtml: `
        <p style="font-size:14px;color:#374151;line-height:1.7;font-family:Arial,sans-serif;">
          Chúng tôi đã nhận được yêu cầu <strong>đặt lại mật khẩu</strong> cho tài khoản của bạn.
          Vui lòng sử dụng mã OTP dưới đây để tiến hành xác thực:
        </p>

        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;margin:24px 0;">
          <tr>
            <td align="center">
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="padding:24px 48px;
                             background-color:#f8fafc;
                             border: 1px solid #e2e8f0;
                             border-radius:12px;
                             text-align:center;">
                    <p style="margin:0 0 8px;font-size:12px;font-weight:600;
                              letter-spacing:0.1em;text-transform:uppercase;
                              color:#64748b;font-family:Arial,sans-serif;">
                      Mã xác thực OTP
                    </p>
                    <p style="margin:0;font-size:40px;font-weight:700;
                              letter-spacing:0.25em;color:#0f172a;
                              font-family:'Courier New',Courier,monospace;">
                      ${otp}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;margin:-8px 0 24px;">
          <tr>
            <td align="center">
              <p style="margin:0;font-size:13px;color:#94a3b8;font-family:Arial,sans-serif;">
                Vui lòng sao chép mã gồm 6 chữ số này
              </p>
            </td>
          </tr>
        </table>

        <!-- Warning box -->
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:#fffbeb;border-radius:10px;
                      border:1px solid #fde68a;border-left:4px solid #f59e0b;
                      margin:16px 0;">
          <tr>
            <td style="padding:16px 20px;">
              <p style="margin:0 0 6px;font-size:11px;font-weight:700;
                        letter-spacing:0.08em;text-transform:uppercase;
                        color:#b45309;font-family:Arial,sans-serif;">
               Lưu ý bảo mật
              </p>
              <ul style="margin:0;padding-left:18px;font-size:13px;
                         color:#78350f;line-height:1.8;font-family:Arial,sans-serif;">
                <li>Mã OTP có hiệu lực trong <strong>5 phút</strong> kể từ khi nhận được email này.</li>
                <li>Mã chỉ được sử dụng <strong>1 lần duy nhất</strong>.</li>
                <li><strong>Không chia sẻ</strong> mã này với bất kỳ ai, kể cả nhân viên FoxTech.</li>
              </ul>
            </td>
          </tr>
        </table>

        <!-- Disclaimer -->
        <p style="font-size:12px;color:#9ca3af;line-height:1.6;
                  font-family:Arial,sans-serif;margin-top:16px;">
          Nếu bạn <strong>không yêu cầu đặt lại mật khẩu</strong>, hãy bỏ qua email này.
          Tài khoản của bạn vẫn hoàn toàn an toàn và không có thay đổi nào được thực hiện.
        </p>
      `,
    });

    await safeSend({
      to: email,
      subject: `[FoxTech] Mã OTP: ${otp} — Đặt lại mật khẩu`,
      html,
      tag: "otp_reset",
    });
  } catch (err) {
    console.error("[Email][otp_reset]", err.message);
    throw err;
  }
};

exports.sendSonarQubeResultEmail = async ({
  groupId,
  taskId,
  projectKey,
  qualityStatus, // 'OK' | 'ERROR'
  branch,
  bugCount,
  vulnCount,
  smellCount,
  coveragePct,
  dashboardUrl,
  ucid, // optional - nếu match được UC cụ thể
}) => {
  try {
    const members = await getGroupMemberEmails(groupId);
    const groupName = await getGroupName(groupId);
    if (!members.length) return;

    const passed = qualityStatus === "OK";
    const iconChar = passed ? "✓" : "✗";
    const tagColor = passed ? "#10b981" : "#ef4444";
    const bgColor = passed ? "#f0fdf4" : "#fef2f2";
    const bdColor = passed ? "#a7f3d0" : "#fca5a5";
    const label = passed ? "PASSED" : "FAILED";

    const metricsRows = [
      ["Bugs", bugCount, bugCount > 0 ? "#ef4444" : "#10b981"],
      ["Vulnerabilities", vulnCount, vulnCount > 0 ? "#ef4444" : "#10b981"],
      ["Code Smells", smellCount, smellCount > 10 ? "#f59e0b" : "#10b981"],
      [
        "Coverage",
        coveragePct != null ? `${coveragePct}%` : "—",
        coveragePct != null && coveragePct < 80 ? "#f59e0b" : "#10b981",
      ],
    ]
      .map(
        ([label, val, color]) => `
        <tr>
          <td style="padding:9px 18px;border-bottom:1px solid #e5e7eb;
                     font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
            ${label}
          </td>
          <td style="padding:9px 18px;border-bottom:1px solid #e5e7eb;
                     font-size:13px;font-weight:700;color:${color};
                     text-align:right;font-family:Arial,sans-serif;">
            ${val}
          </td>
        </tr>`,
      )
      .join("");

    const html = renderEmail({
      subject: `SonarQube ${label}: ${projectKey}${branch ? ` [${branch}]` : ""}`,
      senderName: "SonarQube Bot",
      senderRole: "Phân tích mã nguồn tự động",
      senderEmail: "noreply@foxtech.edu.vn",
      ctaText: "Xem báo cáo chi tiết",
      ctaUrl: dashboardUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p>Phân tích mã nguồn tự động cho dự án
        <strong>${projectKey}</strong>${branch ? ` nhánh <strong>${branch}</strong>` : ""}
        trong nhóm <strong>${groupName}</strong> vừa hoàn tất.</p>

        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;background:${bgColor};border-radius:10px;
                      border:1px solid ${bdColor};margin:20px 0;overflow:hidden;">
          <tr>
            <td style="padding:16px 20px;border-bottom:1px solid ${bdColor};">
              <span style="font-size:22px;font-weight:800;color:${tagColor};
                           font-family:Arial,sans-serif;letter-spacing:0.05em;">
                ${iconChar} Quality Gate: ${label}
              </span>
              ${ucid ? `<span style="margin-left:12px;font-size:12px;color:#6b7280;">UC: ${ucid}</span>` : ""}
            </td>
          </tr>
        </table>

        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;border-radius:8px;overflow:hidden;
                      border:1px solid #e5e7eb;margin:16px 0;">
          <tr>
            <td colspan="2" style="height:2px;background:linear-gradient(90deg,${tagColor},${tagColor}88);font-size:0;">&nbsp;</td>
          </tr>
          ${metricsRows}
        </table>

        ${
          !passed
            ? `
        <p style="font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
          Vui lòng kiểm tra báo cáo chi tiết và sửa các lỗi trước deadline.
          Gate 3 của UC sẽ chuyển sang <span style="color:#10b981;font-weight:600;">xanh</span>
          tự động khi Quality Gate đạt.
        </p>`
            : `
        <p style="font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
          Gate 3 (SonarQube) của UC đã được ghi nhận <span style="color:#10b981;font-weight:600;">PASS</span>.
          Hệ thống sẽ tự động kiểm tra điều kiện nghiệm thu.
        </p>`
        }
      `,
    });

    await safeSend({
      to: members.map((m) => m.Email).filter(Boolean),
      subject: `[SonarQube ${label}] ${projectKey}${branch ? ` · ${branch}` : ""} · ${groupName}`,
      html,
      tag: "sonarqube_result",
    });
  } catch (err) {
    console.error("[Email][sonarqube_result]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// Overdue Warning Email — Gửi cho Leader khi phát hiện items quá hạn
// ═══════════════════════════════════════════════════════════════
exports.sendOverdueWarningEmail = async ({
  leaderId,
  groupId,
  overdueItems, // [{ code, title, type, originalDue }]
  taskUrl,
}) => {
  try {
    const leader = await getUserEmail(leaderId);
    if (!leader?.Email) return;
    const groupName = await getGroupName(groupId);

    const itemRows = overdueItems
      .slice(0, 10) // tối đa 10 items trong email
      .map(
        (item) => `
        <tr>
          <td style="padding:9px 18px;border-bottom:1px solid #fca5a5;
                     font-size:12px;color:#7f1d1d;font-family:Arial,sans-serif;">
            <strong>${item.code}</strong>
          </td>
          <td style="padding:9px 18px;border-bottom:1px solid #fca5a5;
                     font-size:12px;color:#374151;font-family:Arial,sans-serif;">
            ${item.title?.substring(0, 50) || "—"}
          </td>
          <td style="padding:9px 18px;border-bottom:1px solid #fca5a5;
                     font-size:12px;color:#ef4444;font-weight:700;
                     text-align:right;font-family:Arial,sans-serif;">
            ${item.originalDue}
          </td>
        </tr>`,
      )
      .join("");

    const more =
      overdueItems.length > 10
        ? `<p style="font-size:12px;color:#6b7280;text-align:center;">
           ... và ${overdueItems.length - 10} mục khác. Xem đầy đủ tại hệ thống.
         </p>`
        : "";

    const html = renderEmail({
      subject: `Cảnh báo: ${overdueItems.length} mục quá hạn trong ${groupName}`,
      recipientName: leader.Name,
      senderName: "Hệ thống FoxTech",
      senderRole: "Cảnh báo tự động",
      senderEmail: "noreply@foxtech.edu.vn",
      ctaText: "Xem danh sách quá hạn",
      ctaUrl: taskUrl || buildGroupUrl(groupId, groupName),
      bodyHtml: `
        <p>Có <strong style="color:#ef4444;">${overdueItems.length} mục</strong>
        trong nhóm <strong>${groupName}</strong> đã quá deadline và chưa hoàn thành.</p>

        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;border-radius:8px;overflow:hidden;
                      border:1px solid #fca5a5;margin:20px 0;background:#fef2f2;">
          <tr>
            <td style="padding:10px 18px;background:#fee2e2;border-bottom:1px solid #fca5a5;
                       font-size:11px;font-weight:700;color:#991b1b;
                       font-family:Arial,sans-serif;letter-spacing:0.08em;text-transform:uppercase;">
              MÃ
            </td>
            <td style="padding:10px 18px;background:#fee2e2;border-bottom:1px solid #fca5a5;
                       font-size:11px;font-weight:700;color:#991b1b;
                       font-family:Arial,sans-serif;letter-spacing:0.08em;text-transform:uppercase;">
              TIÊU ĐỀ
            </td>
            <td style="padding:10px 18px;background:#fee2e2;border-bottom:1px solid #fca5a5;
                       font-size:11px;font-weight:700;color:#991b1b;text-align:right;
                       font-family:Arial,sans-serif;letter-spacing:0.08em;text-transform:uppercase;">
              DEADLINE
            </td>
          </tr>
          ${itemRows}
        </table>
        ${more}
        <p style="font-size:13px;color:#6b7280;font-family:Arial,sans-serif;">
          Vui lòng vào tab <strong>Overdue</strong> trong hệ thống để xem chi tiết và đánh dấu xử lý.
        </p>
      `,
    });

    await safeSend({
      to: leader.Email,
      subject: `[Quá hạn] ${overdueItems.length} mục chưa hoàn thành · ${groupName}`,
      html,
      tag: "overdue_warning",
    });
  } catch (err) {
    console.error("[Email][overdue_warning]", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// Bulk Reminder Email — Nhắc nhở thủ công gửi nhiều người
// (Dùng khi Leader bấm nút "Nhắc nhở" → channel = email)
// ═══════════════════════════════════════════════════════════════
exports.sendBulkReminderEmail = async ({
  userIds, // [number]
  groupId,
  subject, // Tiêu đề tùy chỉnh
  bodyHtml, // Nội dung HTML
  ctaText,
  ctaUrl,
  senderName,
  senderRole,
}) => {
  try {
    const emails = [];
    for (const uid of userIds) {
      const u = await getUserEmail(uid);
      if (u?.Email) emails.push(u.Email);
    }
    if (!emails.length) return;

    const groupName = await getGroupName(groupId);

    const html = renderEmail({
      subject,
      senderName: senderName || "Hệ thống FoxTech",
      senderRole: senderRole || "Nhắc nhở",
      senderEmail: "noreply@foxtech.edu.vn",
      ctaText: ctaText || "Xem nhiệm vụ",
      ctaUrl: ctaUrl || buildGroupUrl(groupId, groupName),
      bodyHtml,
    });

    await safeSend({
      to: emails,
      subject,
      html,
      tag: "bulk_reminder",
    });
  } catch (err) {
    console.error("[Email][bulk_reminder]", err.message);
  }
};
exports.sendNewAccountEmail = async ({
  email,
  name,
  password = "123456",
  loginUrl,
}) => {
  try {
    if (!email) return;

    const html = renderEmail({
      subject: "Tài khoản FoxTech của bạn đã được tạo",
      recipientName: name,
      senderName: "Hệ thống FoxTech",
      senderRole: "Quản trị viên",
      senderEmail: "noreply@foxtech.edu.vn",
      ctaText: "Đăng nhập ngay",
      ctaUrl: loginUrl || `${process.env.FRONTEND_URL}/login`,
      bodyHtml: `
        <p>Tài khoản của bạn trên hệ thống <strong>FoxTech Academic</strong> đã được tạo thành công.</p>
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;margin:20px 0;">
          <tr><td style="height:2px;background:linear-gradient(90deg,#4b46e5,#6366f1);font-size:0;">&nbsp;</td></tr>
          <tr><td style="padding:16px 20px;border-bottom:1px solid #f3f4f6;">
            <p style="margin:0 0 4px;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">Email đăng nhập</p>
            <p style="margin:0;font-size:15px;font-weight:700;color:#111827;font-family:Arial,sans-serif;">${email}</p>
          </td></tr>
          <tr><td style="padding:16px 20px;">
            <p style="margin:0 0 4px;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">Mật khẩu tạm thời</p>
            <p style="margin:0;font-size:22px;font-weight:800;color:#4b46e5;letter-spacing:0.15em;font-family:Arial,sans-serif;">${password}</p>
          </td></tr>
        </table>
        <table cellpadding="0" cellspacing="0" role="presentation"
               style="width:100%;border-radius:8px;border:1px solid #fde68a;margin:16px 0;background:#fffbeb;">
          <tr><td style="padding:14px 18px;">
            <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#92400e;font-family:Arial,sans-serif;">⚠️ Lưu ý bảo mật</p>
            <p style="margin:0;font-size:13px;color:#78350f;line-height:1.6;font-family:Arial,sans-serif;">
              Vui lòng <strong>đổi mật khẩu ngay sau khi đăng nhập lần đầu</strong> để bảo vệ tài khoản.
            </p>
          </td></tr>
        </table>
      `,
    });

    await safeSend({
      to: email,
      subject: "Tài khoản FoxTech của bạn đã được tạo",
      html,
      tag: "new_account",
    });
  } catch (err) {
    console.error("[Email][new_account]", err.message);
  }
};