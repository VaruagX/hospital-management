// Versioned, additive migration runner.
// Usage: node db/migrate.js [status|up]    (target DB: MIGRATE_DATABASE_URL || DATABASE_URL)
// Each migration runs in its own transaction and is recorded in schema_migrations.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const dir = path.join(__dirname, "migrations");

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("No MIGRATE_DATABASE_URL / DATABASE_URL set");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const client = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamp NOT NULL DEFAULT NOW())`);
  const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const cmd = process.argv[2] || "status";
  for (const f of files) {
    if (done.has(f)) { console.log("applied  ", f); continue; }
    if (cmd !== "up") { console.log("PENDING  ", f); continue; }
    try {
      await client.query("BEGIN");
      await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log("migrated ", f);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("FAILED   ", f, "-", e.message, "(rolled back)");
      process.exitCode = 1;
      break;
    }
  }
  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
