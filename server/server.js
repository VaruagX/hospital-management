require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const cors = require("cors");
const passport = require("./auth");
const pool = require("./config/db");
const apiRoutes = require("./routes/apiRoutes");
const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");
const {
  BASE_URL,
  DEFAULT_SESSION_SECRET,
  PORT,
  SESSION_SECRET,
  isProduction,
  validateProductionConfig,
} = require("./config/runtime");
const { startReminderScheduler } = require("./services/reminderService");

const app = express();

validateProductionConfig();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: BASE_URL,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

if (isProduction && SESSION_SECRET === DEFAULT_SESSION_SECRET) {
  console.warn("SESSION_SECRET is not set. Using the fallback secret is unsafe in production.");
}

app.use(express.static(path.join(__dirname, "../client")));

app.use(authRoutes);
app.use(apiRoutes);
app.use(adminRoutes);

app.get(["/", "/dashboard", "/admin", "/admin/board", "/doctor/:id/today"], (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((error, req, res, next) => {
  console.error(error);
  const status = error.statusCode || 500;
  // Deliberate 4xx errors carry safe, user-facing messages; hide only unexpected 5xx details.
  res.status(status).json({
    error:
      status < 500 || !isProduction
        ? error.message || "Something went wrong"
        : "Something went wrong",
  });
});

// Schema changes are NOT applied at startup. Run `npm run migrate` (db/migrate.js) explicitly.
async function startServer() {
  const missing = await pool.query(
    "SELECT to_regclass('public.audit_logs') AS audit, to_regclass('public.schema_migrations') AS migrations"
  );
  if (!missing.rows[0].audit || !missing.rows[0].migrations) {
    throw new Error("Database is not migrated. Run: npm run migrate");
  }

  app.listen(PORT, () => {
    console.log(`Server running on ${BASE_URL}`);
  });

  startReminderScheduler();
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Unable to start server", error);
    process.exit(1);
  });
}

module.exports = app;
