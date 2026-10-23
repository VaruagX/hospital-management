const DEFAULT_ADMIN_EMAIL = "gauravkale216@gmail.com";
const DEFAULT_DEPLOYMENT_URL = "https://hospital-management-ocvn.onrender.com";
const DEFAULT_SESSION_SECRET = "fallback_secret";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const isProduction = process.env.NODE_ENV === "production";
const configuredBaseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
const isLocalBaseUrl = /localhost|127\.0\.0\.1/.test(configuredBaseUrl || "");
const BASE_URL = isProduction
  ? !isLocalBaseUrl && configuredBaseUrl
    ? configuredBaseUrl
    : DEFAULT_DEPLOYMENT_URL
  : process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL
).toLowerCase();

function isAdminEmail(email) {
  return String(email || "").toLowerCase() === ADMIN_EMAIL;
}

function validateProductionConfig() {
  if (!isProduction) {
    return;
  }

  const missing = [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["GOOGLE_CLIENT_ID", process.env.GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", process.env.GOOGLE_CLIENT_SECRET],
    ["SESSION_SECRET", process.env.SESSION_SECRET],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }
}

module.exports = {
  ADMIN_EMAIL,
  BASE_URL,
  DEFAULT_SESSION_SECRET,
  PORT,
  SESSION_SECRET,
  isAdminEmail,
  isProduction,
  validateProductionConfig,
};
