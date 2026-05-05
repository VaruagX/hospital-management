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
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/dashboard");
  }
);

router.get("/api/session", getSession);
router.post("/api/logout", logout);

module.exports = router;
