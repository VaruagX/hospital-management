const { isAdminEmail } = require("../config/runtime");

const ROLES = ["patient", "receptionist", "doctor", "hospital_admin", "admin"];
const STAFF_ROLES = ["receptionist", "doctor", "hospital_admin", "admin"];

/** Effective role. The configured admin email is always admin; unknown roles collapse to patient. */
function roleOf(user) {
  if (!user) return null;
  if (isAdminEmail(user.email)) return "admin";
  const role = String(user.role || "patient").toLowerCase();
  return ROLES.includes(role) ? role : "patient";
}

function isStaffUser(user) {
  return STAFF_ROLES.includes(roleOf(user));
}

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentication required" });
  }
  if (req.user.is_active === false) {
    return res.status(403).json({ error: "This account has been deactivated" });
  }
  return next();
}

/** Allow only the listed roles (admin is NOT implicitly included unless listed). */
function requireRoles(...allowed) {
  return (req, res, next) =>
    requireAuth(req, res, () => {
      if (allowed.includes(roleOf(req.user))) return next();
      return res.status(403).json({ error: "You do not have permission to perform this action" });
    });
}

const requireAdmin = requireRoles("admin");
const requireStaff = requireRoles(...STAFF_ROLES);

module.exports = { ROLES, STAFF_ROLES, roleOf, isStaffUser, requireAuth, requireRoles, requireAdmin, requireStaff };
