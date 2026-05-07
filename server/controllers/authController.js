async function getSession(req, res) {
  if (!req.isAuthenticated()) {
    return res.json({ authenticated: false, user: null });
  }

  return res.json({
    authenticated: true,
    user: req.user,
  });
}

function logout(req, res, next) {
  const isProduction = process.env.NODE_ENV === "production";

  req.logout((error) => {
    if (error) {
      console.error("Logout failed", error);
      return next(error);
    }

    req.session.destroy((sessionError) => {
      if (sessionError) {
        console.error("Session destroy failed during logout", sessionError);
        return next(sessionError);
      }

      res.clearCookie("connect.sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
      });
      return res.json({ success: true });
    });
  });
}

module.exports = {
  getSession,
  logout,
};
