const { pool } = require("../config/db");

exports.generateUCID = async (taskId) => {
  const result = await pool.query(
    `SELECT "UCID" FROM "ProjectSchedules" WHERE "TaskId" = $1 ORDER BY "Id" DESC LIMIT 1`,
    [taskId]
  );
  if (result.rows.length === 0) return "TC001";
  const lastCode = result.rows[0].UCID;
  const num = parseInt(lastCode.replace("TC", "")) + 1;
  return `TC${num.toString().padStart(3, "0")}`;
};

exports.generateDefectId = async (taskId) => {
  const result = await pool.query(
    `SELECT "DefectId" FROM "IssueTrackings" WHERE "TaskId" = $1 ORDER BY "Id" DESC LIMIT 1`,
    [taskId]
  );
  if (result.rows.length === 0) return "DF001";
  const lastCode = result.rows[0].DefectId;
  const num = parseInt(lastCode.replace("DF", "")) + 1;
  return `DF${num.toString().padStart(3, "0")}`;
};