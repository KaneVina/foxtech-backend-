const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const { connectDB } = require("./config/db");

// ── Khởi tạo app ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ── CORS origins ──────────────────────────────────────────────────────────────
const allowedOrigins = [
  "https://foxtech-frontend-nhjx.vercel.app",
  "https://foxtech-frontend.vercel.app",
  "http://localhost:5173",
];

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  },
});

global.onlineUsers = new Map();
io.on("connection", (socket) => {
  socket.on("add-user", (userId) => {
    global.onlineUsers.set(userId, socket.id);
  });
  socket.on("disconnect", () => {
    for (let [key, value] of global.onlineUsers.entries()) {
      if (value === socket.id) {
        global.onlineUsers.delete(key);
        break;
      }
    }
  });
});
global.io = io;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());

app.use(cors({
  origin: (origin, cb) =>
    !origin || allowedOrigins.includes(origin)
      ? cb(null, true)
      : cb(new Error("CORS blocked")),
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// Giới hạn chung: 100 request / 15 phút / IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều request, vui lòng thử lại sau." },
}));

// Giới hạn login: 10 lần / 15 phút / IP — chống brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Đăng nhập quá nhiều lần, thử lại sau 15 phút." },
});

connectDB();

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth/login",    loginLimiter); // ← phải trước authRoutes
app.use("/api/auth",          require("./routes/authRoutes"));
app.use("/api/groups",        require("./routes/groupRoutes"));
app.use("/api/tasks",         require("./routes/taskRoutes"));
app.use("/api/resources",     require("./routes/resourceRoutes"));
app.use("/api/requests",      require("./routes/requestRoutes"));
app.use("/api/users",         require("./routes/userRoutes"));
app.use("/api/notifications", require("./routes/notificationRoutes"));
app.use("/api/metadata",      require("./routes/metadataRoutes"));
app.use("/api",               require("./routes/projectRoutes"));
app.use("/api/admin",         require("./routes/adminRoutes"));
app.use("/api/courses",       require("./routes/courseRoutes"));
app.use("/api/exam-sessions", require("./routes/examSessionRoutes"));
app.use("/api/upload",        require("./routes/uploadRoutes"));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Frontend static ───────────────────────────────────────────────────────────
const frontendPath = path.join(__dirname, "../frontend/dist");
app.use(express.static(frontendPath));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

require("./jobs/deadlineChecker");