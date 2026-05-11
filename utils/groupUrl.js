const { pool } = require("../config/db");

const CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE = CHARS.length;
const SALT = 47391;

function encodeGroupId(id) {
  let n = (parseInt(id, 10) ^ SALT) >>> 0;
  if (n === 0) return CHARS[0];
  let result = "";
  while (n > 0) { result = CHARS[n % BASE] + result; n = Math.floor(n / BASE); }
  return result;
}

function slugifyGroupName(name) {
  return String(name).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d").replace(/[^a-z0-9\s-]/g, "")
    .trim().replace(/\s+/g, "-").replace(/-+/g, "-");
}

function buildGroupUrl(groupId, groupName) {
  const hash = encodeGroupId(groupId);
  const slug = slugifyGroupName(groupName || "group");
  return `${process.env.FRONTEND_URL}/group/${hash}/${slug}`;
}

async function getGroupName(groupId) {
  if (!groupId) return "group";
  const res = await pool.query(`SELECT "Name" FROM "Groups" WHERE "Id" = $1`, [groupId]);
  return res.rows[0]?.Name || "group";
}

module.exports = { buildGroupUrl, getGroupName, encodeGroupId, slugifyGroupName };