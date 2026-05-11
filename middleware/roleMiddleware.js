function checkRole(allowedRoles) {
  return (req, res, next) => {
    // Ép mảng quyền cần thiết về chữ thường (vd: ['admin'])
    const roles = (
      Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]
    ).map((r) => r.toLowerCase());

    // Bắt đúng Key (role hay Role) và ép về chữ thường để so sánh vô tư không sợ sai chính tả
    const userRole = (req.user.role || req.user.Role || "").toLowerCase();

    if (!roles.includes(userRole)) {
      console.warn(
        `⛔ Chặn truy cập: User có role là '${userRole}' nhưng route yêu cầu '${roles}'`,
      );
      return res
        .status(403) // 403 Forbidden: Đúng người nhưng sai quyền
        .json("Permission denied: You do not have the required role");
    }

    next();
  };
}

module.exports = checkRole;
