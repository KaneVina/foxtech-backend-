const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");
require("dotenv").config();

// Cấu hình Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Hàm tạo storage theo folder & định dạng ──────────────────────────────────
function makeStorage(folder, allowedFormats = ["jpg", "jpeg", "png", "webp"]) {
  return new CloudinaryStorage({
    cloudinary,
    params: {
      folder,                      // Thư mục trên Cloudinary
      allowed_formats: allowedFormats,
      // Chỉ lưu public_id ngắn gọn (không extension, không path dư thừa)
      public_id: (req, file) => {
        const name = file.originalname.replace(/\.[^/.]+$/, "").replace(/\s+/g, "_");
        return `${Date.now()}_${name}`;
      },
      // Tự động nén & chuyển sang webp để tiết kiệm dung lượng tối đa
      transformation: [{ quality: "auto", fetch_format: "auto" }],
    },
  });
}

// ── Các uploader theo từng loại ───────────────────────────────────────────────

// Avatar người dùng — tối đa 2MB, crop thành hình vuông 400x400
const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "studygroup/avatars",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    public_id: (req, file) => `${Date.now()}_user${req.user?.id || "unknown"}`,
    transformation: [
      { width: 400, height: 400, crop: "fill", gravity: "face", quality: "auto", fetch_format: "auto" },
    ],
  },
});

// Logo trường — tối đa 2MB, giữ tỉ lệ, tối đa 300px chiều rộng
const logoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "studygroup/logos",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "svg"],
    public_id: (req, file) => `${Date.now()}_logo`,
    transformation: [
      { width: 300, crop: "limit", quality: "auto", fetch_format: "auto" },
    ],
  },
});

// Thumbnail khóa học — 16:9, 800x450
const thumbnailStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "studygroup/thumbnails",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    public_id: (req, file) => `${Date.now()}_thumb`,
    transformation: [
      { width: 800, height: 450, crop: "fill", quality: "auto", fetch_format: "auto" },
    ],
  },
});

// Tài liệu / Evidence — cho phép pdf, doc, docx, ảnh
const documentStorage = makeStorage("studygroup/documents", [
  "jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xlsx", "pptx",
]);

// ── Giới hạn file size ────────────────────────────────────────────────────────
const imgLimit  = { fileSize: 2 * 1024 * 1024 };   // 2MB cho ảnh
const docLimit  = { fileSize: 10 * 1024 * 1024 };  // 10MB cho tài liệu

// ── Export các middleware multer ──────────────────────────────────────────────
exports.uploadAvatar    = multer({ storage: avatarStorage,    limits: imgLimit });
exports.uploadLogo      = multer({ storage: logoStorage,      limits: imgLimit });
exports.uploadThumbnail = multer({ storage: thumbnailStorage, limits: imgLimit });
exports.uploadDocument  = multer({ storage: documentStorage,  limits: docLimit });

// ── Helper: xoá ảnh cũ trên Cloudinary khi thay ảnh mới ─────────────────────
exports.deleteCloudinaryImage = async (url) => {
  if (!url || url.startsWith("https://i.pravatar")) return; // bỏ qua placeholder
  try {
    // Lấy public_id từ URL Cloudinary
    const parts = url.split("/");
    const uploadIndex = parts.indexOf("upload");
    if (uploadIndex === -1) return;
    // Bỏ version (vXXXX) nếu có, lấy path từ folder trở đi, bỏ extension
    const rawSegments = parts.slice(uploadIndex + 1);
    const withoutVersion = rawSegments[0]?.match(/^v\d+$/) ? rawSegments.slice(1) : rawSegments;
    const publicId = withoutVersion.join("/").replace(/\.[^/.]+$/, "");
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.error("Lỗi xóa ảnh Cloudinary:", err);
  }
};

exports.cloudinary = cloudinary;

// CSV upload — dùng memoryStorage (không lưu file, parse xong bỏ)
exports.uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.endsWith(".csv")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Chỉ chấp nhận file CSV"));
    }
  },
});