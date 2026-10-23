const { isAdminEmail } = require("../config/runtime");

function isStaffUser(user) {
  return Boolean(
    user &&
      ["admin", "doctor"].includes(String(user.role || "").toLowerCase())
  );
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  return res.status(401).json({ error: "Authentication required" });
}

function requireAdmin(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentication required" });
  }

  if (
    String(req.user.role || "").toLowerCase() === "admin" ||
    isAdminEmail(req.user.email)
  ) {
    return next();
  }

  return res.status(403).json({ error: "Admin access required" });
}

function requireStaff(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentication required" });
  }

  if (isAdminEmail(req.user.email) || isStaffUser(req.user)) {
    return next();
  }

  return res.status(403).json({ error: "Staff access required" });
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireStaff,
  isStaffUser,
};
