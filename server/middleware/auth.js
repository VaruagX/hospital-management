const ADMIN_EMAIL = "gauravkale216@gmail.com";

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

  if (req.user.role === "admin" || req.user.email === ADMIN_EMAIL) {
    return next();
  }

  return res.status(403).json({ error: "Admin access required" });
}

module.exports = {
  requireAuth,
  requireAdmin,
};
