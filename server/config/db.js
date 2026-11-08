const { Pool } = require("pg");

const isTest = process.env.NODE_ENV === "test";
const connectionString = isTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString || "");

// Tests must never be able to touch a remote (production) database.
if (isTest && (!connectionString || !isLocal)) {
  throw new Error("NODE_ENV=test requires TEST_DATABASE_URL pointing at a localhost database");
}

const pool = new Pool({
  connectionString,
  ssl: connectionString && !isLocal ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
