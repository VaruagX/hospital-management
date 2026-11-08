// Small, dependency-free input validators. Each throws a 400 error with a user-safe message.
function fail(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value, label, { required = false, max = 300 } = {}) {
  const s = value == null ? "" : String(value).trim();
  if (!s) {
    if (required) throw fail(`${label} is required`);
    return null;
  }
  if (s.length > max) throw fail(`${label} must be at most ${max} characters`);
  return s;
}

function time(value, label) {
  if (value == null || value === "") return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw fail(`${label} must be HH:MM`);
  return String(value);
}

function money(value, label, { max = 1000000 } = {}) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw fail(`${label} must be between 0 and ${max}`);
  return Math.round(n * 100) / 100;
}

function intRange(value, label, min, max) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(`${label} must be a whole number between ${min} and ${max}`);
  return n;
}

function email(value, label = "Email") {
  const s = text(value, label, { max: 254 });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw fail(`${label} is not valid`);
  return s ? s.toLowerCase() : null;
}

function phone(value, label = "Phone") {
  const s = text(value, label, { max: 20 });
  if (s && !/^[0-9+\-\s()]{7,20}$/.test(s)) throw fail(`${label} is not valid`);
  return s;
}

/** Image reference: uploaded media path or an https URL. Anything else (javascript:, data:) is rejected. */
function imageRef(value, label = "Image") {
  const s = text(value, label, { max: 500 });
  if (s && !/^(\/media\/\d+|https:\/\/[^\s]+)$/.test(s)) throw fail(`${label} must be an uploaded image or an https URL`);
  return s;
}

module.exports = { fail, parseId, text, time, money, intRange, email, phone, imageRef };
