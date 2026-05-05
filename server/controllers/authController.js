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
  req.logout((error) => {
    if (error) {
      return next(error);
    }

    req.session.destroy((sessionError) => {
      if (sessionError) {
        return next(sessionError);
      }

      res.clearCookie("connect.sid");
      return res.json({ success: true });
    });
  });
}

module.exports = {
  getSession,
  logout,
};
