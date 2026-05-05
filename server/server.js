require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const cors = require("cors");
const passport = require("./auth");
const apiRoutes = require("./routes/apiRoutes");
const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");
const { ensureSchema } = require("./config/schema");
const { startReminderScheduler } = require("./services/reminderService");

const app = express();
const PORT = Number(process.env.PORT) || 8000;
const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(
  cors({
    origin: baseUrl,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

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
  res.status(error.statusCode || 500).json({
    error: error.message || "Something went wrong",
  });
});

async function startServer() {
  await ensureSchema();

  app.listen(PORT, () => {
    console.log(`Server running on ${baseUrl}`);
  });

  startReminderScheduler();
}

startServer().catch((error) => {
  console.error("Unable to start server", error);
  process.exit(1);
});
