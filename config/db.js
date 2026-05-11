const { Pool } = require("pg");
require("dotenv").config();

// ─── Khởi tạo Pool kết nối tới Supabase ──────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Bắt buộc cho Supabase
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// ─── Set timezone UTC+7 cho mọi connection mới ───────────────
// FIX: Dùng async/await thay vì gọi client.query() trực tiếp
pool.on("connect", async (client) => {
  try {
    await client.query("SET TIME ZONE 'Asia/Ho_Chi_Minh'");
  } catch (err) {
    console.error("❌ Lỗi set timezone:", err.message);
  }
});

// ─── Log lỗi connection pool (không crash server) ────────────
pool.on("error", (err) => {
  console.error("❌ PostgreSQL pool error:", err.message);
});

// ─── Kiểm tra kết nối khi khởi động ──────────────────────────
async function connectDB() {
  try {
    const client = await pool.connect();
    const tzRes = await client.query("SHOW TIME ZONE");
    console.log("✅ Kết nối PostgreSQL (Supabase) thành công!");
    console.log(`🕐 Timezone: ${tzRes.rows[0].TimeZone}`);
    client.release();
  } catch (err) {
    console.error("❌ LỖI KẾT NỐI DATABASE:", err.message);
    process.exit(1);
  }
}

module.exports = { pool, connectDB };
