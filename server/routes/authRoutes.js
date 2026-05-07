const express = require("express");
const passport = require("../auth");
const { getSession, logout } = require("../controllers/authController");

const router = express.Router();

router.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

router.get(
  "/auth/google/callback",
  (req, res, next) => {
    passport.authenticate("google", (error, user, info) => {
      if (error) {
        console.error("Google OAuth callback failed", error);
        return res.redirect("/?authError=google");
      }

      if (!user) {
        console.error("Google OAuth did not return a user", info);
        return res.redirect("/?authError=google");
      }

      req.logIn(user, (loginError) => {
        if (loginError) {
          console.error("Google OAuth login session failed", loginError);
          return next(loginError);
        }

        req.session.save((sessionError) => {
          if (sessionError) {
            console.error("Google OAuth session save failed", sessionError);
            return next(sessionError);
          }

          return res.redirect("/dashboard");
        });
      });
    })(req, res, next);
  }
);

router.get("/api/session", getSession);
router.post("/api/logout", logout);

module.exports = router;
