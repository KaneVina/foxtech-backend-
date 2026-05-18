// projectRoutes.js — PHIÊN BẢN ĐẦY ĐỦ (thay thế toàn bộ file cũ)
const express = require("express");
const router = express.Router({ mergeParams: true });
const ctrl = require("../controllers/projectController");
const uploadCtrl = require("../controllers/uploadController");
const { verifyToken } = require("../middleware/authMiddleware");

// ─── Schedule (UC) ────────────────────────────────────────────
router.get("/tasks/:taskId/schedules", verifyToken, ctrl.getSchedules);
router.post("/tasks/:taskId/schedules", verifyToken, ctrl.createSchedule);

// ← PHẢI đứng trước updateSchedule để tránh conflict route
router.put(
  "/tasks/:taskId/schedules/:scheduleId/sonarqube/assign-by-hash",
  verifyToken,
  ctrl.assignSonarByHash,
);

router.put(
  "/tasks/:taskId/schedules/:scheduleId",
  verifyToken,
  ctrl.updateSchedule,
);
router.delete(
  "/tasks/:taskId/schedules/:scheduleId",
  verifyToken,
  ctrl.deleteSchedule,
);

// ─── Issue Tracking ───────────────────────────────────────────
router.get("/tasks/:taskId/issues", verifyToken, ctrl.getIssues);
router.post("/tasks/:taskId/issues", verifyToken, ctrl.createIssue);
router.put("/tasks/:taskId/issues/:issueId", verifyToken, ctrl.updateIssue);
router.delete("/tasks/:taskId/issues/:issueId", verifyToken, ctrl.deleteIssue);

// ─── Project Stats ────────────────────────────────────────────
router.get("/tasks/:taskId/project-stats", verifyToken, ctrl.getStats);

// ─── Gate Status ──────────────────────────────────────────────
router.get(
  "/tasks/:taskId/schedules/:scheduleId/gate-status",
  verifyToken,
  ctrl.getGateStatus,
);

// ─── Code Push (Gate 1 draw tab) ──────────────────────────────
router.get(
  "/tasks/:taskId/schedules/:scheduleId/code-pushes",
  verifyToken,
  ctrl.getCodePushes,
);
router.post(
  "/tasks/:taskId/schedules/:scheduleId/code-pushes",
  verifyToken,
  ctrl.createCodePush,
);
router.put(
  "/tasks/:taskId/schedules/:scheduleId/code-pushes/:pushId/review",
  verifyToken,
  ctrl.reviewCodePush,
);

// ─── Documents (Gate 2 drawer tab) ───────────────────────────
router.get(
  "/tasks/:taskId/schedules/:scheduleId/documents",
  verifyToken,
  ctrl.getDocuments,
);
router.post(
  "/tasks/:taskId/schedules/:scheduleId/documents",
  verifyToken,
  ctrl.createDocument,
);
router.put(
  "/tasks/:taskId/schedules/:scheduleId/documents/:docId",
  verifyToken,
  ctrl.updateDocument,
);
router.put(
  "/tasks/:taskId/schedules/:scheduleId/documents/:docId/review",
  verifyToken,
  ctrl.reviewDocument,
);
router.delete(
  "/tasks/:taskId/schedules/:scheduleId/documents/:docId",
  verifyToken,
  ctrl.deleteDocument,
);

// ─── Nhắc nhở thủ công ───────────────────────────────────────
// POST body: { channel: 'notification'|'email'|'both', userIds?: [...], message?: '' }
router.post(
  "/tasks/:taskId/schedules/:scheduleId/remind",
  verifyToken,
  ctrl.sendReminder,
);
router.post(
  "/tasks/:taskId/issues/:issueId/remind",
  verifyToken,
  ctrl.sendIssueReminder,
);

// ─── GitHub Tab ───────────────────────────────────────────────
router.get("/tasks/:taskId/github/config", verifyToken, ctrl.getGithubConfig);
router.put("/tasks/:taskId/github/config", verifyToken, ctrl.saveGithubConfig);
router.get("/tasks/:taskId/github/proxy", verifyToken, ctrl.proxyGithubApi);
router.get(
  "/tasks/:taskId/github/webhook-logs",
  verifyToken,
  ctrl.getWebhookLogs,
);

// ─── SonarQube Tab ────────────────────────────────────────────
router.get("/tasks/:taskId/sonarqube/config", verifyToken, ctrl.getSonarConfig);
router.put(
  "/tasks/:taskId/sonarqube/config",
  verifyToken,
  ctrl.saveSonarConfig,
);
// ?scheduleId=xxx để lấy kết quả của 1 UC; không có → toàn task
router.get(
  "/tasks/:taskId/sonarqube/results",
  verifyToken,
  ctrl.getSonarResults,
);
// Gán kết quả scan vào UC theo commit hash
router.put(
  "/tasks/:taskId/sonarqube/results/:resultId/assign",
  verifyToken,
  ctrl.assignSonarResult,
);

// ─── Workload ─────────────────────────────────────────────────
router.get("/tasks/:taskId/workload-stats", verifyToken, ctrl.getWorkloadStats);

// ─── Overdue Logs ─────────────────────────────────────────────
// ?handled=0|1 để filter; không có → all
router.get("/tasks/:taskId/overdue-logs", verifyToken, ctrl.getOverdueLogs);
router.put(
  "/tasks/:taskId/overdue-logs/:logId/handle",
  verifyToken,
  ctrl.handleOverdueLog,
);

// ─── Project Settings (toàn nhóm) ────────────────────────────
// ?key=schedule|issue
router.get("/tasks/:taskId/settings", verifyToken, ctrl.getProjectSettings);
router.put("/tasks/:taskId/settings", verifyToken, ctrl.saveProjectSettings);

// ─── Upload file (Cloudinary) ─────────────────────────────────
// Dùng cho EvidenceUrl trong IssueTracking, Documents trong UCDocuments
// Frontend POST multipart/form-data với field "file"
router.post("/upload/evidence", verifyToken, uploadCtrl.uploadEvidence);
router.post("/upload/document", verifyToken, uploadCtrl.uploadDocument);
router.delete("/upload/file", verifyToken, uploadCtrl.deleteFile);

// ─── Webhooks công khai (bảo mật bằng HMAC, KHÔNG dùng verifyToken) ──
// GitHub: bảo mật bằng GITHUB_WEBHOOK_SECRET
router.post("/webhook/github", ctrl.handleGithubWebhook);
// SonarQube: bảo mật bằng SONARQUBE_WEBHOOK_SECRET
router.post("/webhook/sonarqube", ctrl.handleSonarQubeWebhook);
// ─── Resource Links (tab "Links") ─────────────────────────────────
router.get("/tasks/:taskId/resource-links", verifyToken, ctrl.getResourceLinks);
router.post("/tasks/:taskId/resource-links", verifyToken, ctrl.createResourceLink);
router.delete(
  "/tasks/:taskId/resource-links/:linkId",
  verifyToken,
  ctrl.deleteResourceLink,
);

module.exports = router;