const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const pool = require("./config/db");

const ADMIN_EMAIL = "gauravkale216@gmail.com";
const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const isProduction = process.env.NODE_ENV === "production";
const configuredBaseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
const isLocalBaseUrl = /localhost|127\.0\.0\.1/.test(configuredBaseUrl || "");
const BASE_URL = isProduction
  ? !isLocalBaseUrl && configuredBaseUrl
    ? configuredBaseUrl
    : "https://hospital-management-ocvn.onrender.com"
  : process.env.BASE_URL || `http://localhost:${PORT}`;

async function syncUser(profile) {
  const email = profile.emails?.[0]?.value?.toLowerCase();
  if (!email) {
    throw new Error("Google account email is required");
  }

  const name = profile.displayName || profile.name?.givenName || "Patient";
  const photo = profile.photos?.[0]?.value || null;
  const forcedRole = email === ADMIN_EMAIL ? "admin" : null;

  const existingUserResult = await pool.query(
    "SELECT * FROM users WHERE email = $1 LIMIT 1",
    [email]
  );

  if (existingUserResult.rows[0]) {
    const existingUser = existingUserResult.rows[0];
    const role = forcedRole || existingUser.role || "patient";
    const updatedUserResult = await pool.query(
      `UPDATE users
       SET name = $1, photo = $2, role = $3
       WHERE id = $4
       RETURNING id, name, email, photo, role, phone`,
      [name, photo, role, existingUser.id]
    );
    return updatedUserResult.rows[0];
  }

  const insertUserResult = await pool.query(
    `INSERT INTO users (name, email, photo, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, photo, role, phone`,
    [name, email, photo, forcedRole || "patient"]
  );

  return insertUserResult.rows[0];
}

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await syncUser(profile);
        done(null, user);
      } catch (error) {
        console.error("Google authentication failed while syncing user", error);
        done(error);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  if (!user?.id) {
    return done(new Error("Cannot serialize user without an id"));
  }

  return done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, photo, role, phone FROM users WHERE id = $1",
      [id]
    );
    done(null, result.rows[0] || null);
  } catch (error) {
    console.error("Failed to deserialize authenticated user", error);
    done(error);
  }
});

module.exports = passport;
