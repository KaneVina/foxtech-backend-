// ═══════════════════════════════════════════════════════════════
// uploadController.js
// Upload file lên Cloudinary (free tier, đã có account sẵn)
// Hỗ trợ:
//   - Ảnh bằng chứng (Evidence) cho IssueTracking
//   - Tài liệu (Documents) cho UCDocuments
//
// CÁCH CÀI ĐẶT:
//   npm install multer cloudinary multer-storage-cloudinary
//
// BIẾN MÔI TRƯỜNG (.env) — thêm vào:
//   CLOUDINARY_CLOUD_NAME=depz8k6gz    (lấy từ emailService.js)
//   CLOUDINARY_API_KEY=your_api_key
//   CLOUDINARY_API_SECRET=your_api_secret
//
// Lấy API Key & Secret tại:
//   https://console.cloudinary.com → Settings → API Keys
// ═══════════════════════════════════════════════════════════════

const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");
const path = require("path");

// ─── Cấu hình Cloudinary ──────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "depz8k6gz",
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── File type validation ─────────────────────────────────────
const ALLOWED_EVIDENCE_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
];

const ALLOWED_DOCUMENT_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

// ─── Storage Evidence (ảnh → auto compress) ───────────────────
const evidenceStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "foxtech/evidence",
    resource_type: "image",
    // Auto quality và format tối ưu, max width 2000px
    transformation: [
      { width: 2000, crop: "limit", quality: "auto", fetch_format: "auto" },
    ],
    // Tên file: evidence_<timestamp>_<random>
    public_id: `evidence_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
  }),
});

// ─── Storage Document (raw file) ──────────────────────────────
const documentStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isImage = ALLOWED_EVIDENCE_MIME.includes(file.mimetype);
    return {
      folder: "foxtech/documents",
      resource_type: isImage ? "image" : "raw",
      public_id: `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`,
      // Với ảnh: compress
      ...(isImage && {
        transformation: [{ quality: "auto", fetch_format: "auto" }],
      }),
    };
  },
});

// ─── Multer instances ─────────────────────────────────────────
// Giới hạn 25MB cho evidence, 50MB cho document
const uploadEvidenceMiddleware = multer({
  storage: evidenceStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_EVIDENCE_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Định dạng không hỗ trợ: ${file.mimetype}. Chỉ nhận ảnh.`));
    }
  },
}).single("file");

const uploadDocumentMiddleware = multer({
  storage: documentStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_DOCUMENT_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Định dạng không hỗ trợ. Chỉ nhận ảnh, PDF, Word, Excel, PowerPoint.`,
        ),
      );
    }
  },
}).single("file");

// ─── Helper: Tạo multer error response thân thiện ─────────────
function handleMulterError(err, res) {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      message: "File quá lớn. Ảnh tối đa 25MB, tài liệu tối đa 50MB.",
    });
  }
  return res.status(400).json({
    success: false,
    message: err.message || "Lỗi upload file.",
  });
}

// ═══════════════════════════════════════════════════════════════
// CONTROLLER: Upload ảnh bằng chứng
// POST /api/projects/upload/evidence
// Form-data: file (ảnh)
// Response: { success, url, publicId, width, height, format, bytes }
// ═══════════════════════════════════════════════════════════════
exports.uploadEvidence = (req, res) => {
  uploadEvidenceMiddleware(req, res, (err) => {
    if (err) return handleMulterError(err, res);

    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Không có file được chọn." });
    }

    // Cloudinary trả thông tin qua req.file
    const f = req.file;

    // secure_url là URL HTTPS Cloudinary (CDN, tốc độ cao)
    return res.json({
      success: true,
      url: f.path, // secure_url từ Cloudinary
      publicId: f.filename, // public_id để xóa sau
      width: f.width || null,
      height: f.height || null,
      format: f.format || null,
      bytes: f.size || null,
    });
  });
};

// ═══════════════════════════════════════════════════════════════
// CONTROLLER: Upload tài liệu (PDF, Word, Excel, ảnh...)
// POST /api/projects/upload/document
// Response: { success, url, publicId, filename, bytes, resourceType }
// ═══════════════════════════════════════════════════════════════
exports.uploadDocument = (req, res) => {
  uploadDocumentMiddleware(req, res, (err) => {
    if (err) return handleMulterError(err, res);

    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Không có file được chọn." });
    }

    const f = req.file;
    return res.json({
      success: true,
      url: f.path,
      publicId: f.filename,
      originalName: f.originalname,
      bytes: f.size || null,
      resourceType: f.resource_type || "raw",
    });
  });
};

// ═══════════════════════════════════════════════════════════════
// CONTROLLER: Xóa file khỏi Cloudinary
// DELETE /api/projects/upload/file
// Body: { publicId, resourceType? }
// ═══════════════════════════════════════════════════════════════
exports.deleteFile = async (req, res) => {
  try {
    const { publicId, resourceType = "image" } = req.body;

    if (!publicId) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu publicId." });
    }

    // Chỉ xóa file trong folder của app (bảo mật)
    if (!publicId.startsWith("foxtech/")) {
      return res.status(403).json({
        success: false,
        message: "Không được phép xóa file nằm ngoài thư mục ứng dụng.",
      });
    }

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });

    if (result.result === "ok" || result.result === "not found") {
      return res.json({ success: true, message: "Đã xóa file." });
    }

    return res
      .status(500)
      .json({ success: false, message: "Xóa file thất bại.", detail: result });
  } catch (err) {
    console.error("deleteFile:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi server: " + err.message });
  }
};
