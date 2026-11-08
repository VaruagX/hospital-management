const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pool, resetDb, startApp } = require("./helpers");

after(async () => { await pool.end(); });

test("every migration file is recorded and re-running the runner changes nothing", async () => {
  await resetDb();
  const files = fs.readdirSync(path.join(__dirname, "../db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
  assert.deepEqual(rows.map((r) => r.name), files);
  const out = execFileSync("node", [path.join(__dirname, "../db/migrate.js"), "up"], {
    env: { ...process.env, MIGRATE_DATABASE_URL: process.env.TEST_DATABASE_URL },
  }).toString();
  assert.ok(!out.includes("migrated"), out);
});

test("migrations preserve pre-existing rows (additive only)", async () => {
  await resetDb();
  await pool.query("INSERT INTO users (email, name) VALUES ('keep@x.test', 'Keep')");
  execFileSync("node", ["-e", `
    const {Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.TEST_DATABASE_URL});await c.connect();
    for (const f of ["000_baseline.sql","001_hms_core.sql","002_lifecycle_rbac.sql"]) await c.query(require("fs").readFileSync("db/migrations/"+f,"utf8"));
    await c.end();})()`], { env: process.env, cwd: path.join(__dirname, "..") });
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM users WHERE email='keep@x.test'")).rows[0].n, 1);
});

test("application code performs no schema changes at startup", () => {
  assert.ok(!fs.existsSync(path.join(__dirname, "../server/config/schema.js")));
  const src = fs.readdirSync(path.join(__dirname, "../server"), { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => [f, fs.readFileSync(path.join(__dirname, "../server", f), "utf8")]);
  for (const [f, text] of src) {
    assert.ok(!/ensureSchema/.test(text), `${f} still references ensureSchema`);
    assert.ok(!/\b(CREATE|ALTER|DROP)\s+TABLE\b/i.test(text), `${f} contains DDL`);
  }
});

test("real server app: health ok, auth gate intact, importing it does not listen", async () => {
  const app = require("../server/server"); // must not start listening on import
  const s = await startApp(app);
  assert.equal((await s.call("GET", "/health")).status, 200);
  assert.equal((await s.call("GET", "/api/session")).json.authenticated, false);
  assert.equal((await s.call("GET", "/cities")).status, 401);
  assert.equal((await s.call("GET", "/admin/stats")).status, 401);
  assert.equal((await s.call("GET", "/nope")).status, 404);
  await s.close();
});
