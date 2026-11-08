// Shared test harness. Safe by construction: server/config/db.js refuses to start under
// NODE_ENV=test unless TEST_DATABASE_URL is a localhost database.
process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://localhost/pulsecare_test";
process.env.ADMIN_EMAIL = "root@test.local";
process.env.SESSION_SECRET = "test-secret";
// Placeholders so the Google strategy can be constructed; no OAuth call is ever made in tests.
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const express = require("express");
const pool = require("../server/config/db");

let migrated = false;
function migrate() {
  if (migrated) return;
  execFileSync("node", [path.join(__dirname, "../db/migrate.js"), "up"], {
    env: { ...process.env, MIGRATE_DATABASE_URL: process.env.TEST_DATABASE_URL },
    stdio: "pipe",
  });
  migrated = true;
}

async function resetDb() {
  migrate();
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
  );
  await pool.query(
    `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
  );
}

/** Express app using the real routers/middleware, but a header-driven stand-in for Passport login. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(async (req, res, next) => {
    const id = Number(req.get("x-test-user"));
    req.user = null;
    if (id) {
      const { rows } = await pool.query(
        "SELECT id, name, email, photo, role, phone, hospital_id, doctor_id, is_active FROM users WHERE id = $1",
        [id]
      );
      req.user = rows[0] || null;
    }
    req.isAuthenticated = () => Boolean(req.user);
    next();
  });
  app.use(require("../server/routes/apiRoutes"));
  app.use(require("../server/routes/adminRoutes"));
  app.use((error, req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message });
  });
  return app;
}

async function startApp(app = buildApp()) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, { as, body } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(as ? { "x-test-user": String(as) } : {}),
      },
      body: body && method !== "GET" ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* csv etc. */ }
    return { status: res.status, json, text };
  }
  return { base, call, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Two hospitals, three doctors and one user per role. Returns ids by name.
 * Hospital A: doctors dA1, dA2.  Hospital B: doctor dB1.
 */
async function seedWorld() {
  const q = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const city = await q("INSERT INTO cities (name) VALUES ('Testville') RETURNING id");
  const dep = await q("INSERT INTO departments (name) VALUES ('General') RETURNING id");
  const hA = await q("INSERT INTO hospitals (name, city_id, location) VALUES ('Alpha', $1, 'x') RETURNING id", [city.id]);
  const hB = await q("INSERT INTO hospitals (name, city_id, location) VALUES ('Beta', $1, 'y') RETURNING id", [city.id]);
  const doc = (name, h) =>
    q(
      `INSERT INTO doctors (name, specialization, hospital_id, department_id, available_from, available_to,
                            unavailable_days, max_patients_per_day)
       VALUES ($1, 'General', $2, $3, '09:00', '12:00', '', 24) RETURNING id`,
      [name, h, dep.id]
    );
  const dA1 = await doc("Dr A1", hA.id);
  const dA2 = await doc("Dr A2", hA.id);
  const dB1 = await doc("Dr B1", hB.id);
  const user = (email, role, extra = {}) =>
    q(
      `INSERT INTO users (email, name, role, hospital_id, doctor_id, is_active)
       VALUES ($1, $1, $2, $3, $4, $5) RETURNING id`,
      [email, role, extra.hospital_id ?? null, extra.doctor_id ?? null, extra.is_active ?? true]
    );
  const ids = {
    cityId: city.id, depId: dep.id, hA: hA.id, hB: hB.id, dA1: dA1.id, dA2: dA2.id, dB1: dB1.id,
    admin: (await user("root@test.local", "admin")).id,
    hospAdminA: (await user("ha@a.test", "hospital_admin", { hospital_id: hA.id })).id,
    hospAdminB: (await user("hb@b.test", "hospital_admin", { hospital_id: hB.id })).id,
    recepA: (await user("rc@a.test", "receptionist", { hospital_id: hA.id })).id,
    docUserA1: (await user("d1@a.test", "doctor", { hospital_id: hA.id, doctor_id: dA1.id })).id,
    docUserA2: (await user("d2@a.test", "doctor", { hospital_id: hA.id, doctor_id: dA2.id })).id,
    docUnlinked: (await user("dx@a.test", "doctor")).id,
    inactiveStaff: (await user("off@a.test", "receptionist", { hospital_id: hA.id, is_active: false })).id,
    patient: (await user("p1@x.test", "patient")).id,
    patient2: (await user("p2@x.test", "patient")).id,
  };
  const appt = async (docId, hospId, userId, token, name) =>
    (
      await q(
        `INSERT INTO appointments (user_id, user_name, mobile, doctor_id, hospital_id, appointment_date,
                                   token_number, slot_number, status, reason_for_visit, visit_notes)
         VALUES ($1, $2, '9999999999', $3, $4, CURRENT_DATE, $5, $5, 'booked', 'checkup', 'secret note')
         RETURNING id`,
        [userId, name, docId, hospId, token]
      )
    ).id;
  ids.apptA1 = await appt(ids.dA1, ids.hA, ids.patient, 1, "Pat One");
  ids.apptA2 = await appt(ids.dA2, ids.hA, ids.patient2, 1, "Pat Two");
  ids.apptB1 = await appt(ids.dB1, ids.hB, ids.patient2, 1, "Pat Three");
  return ids;
}

function dateOffset(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

module.exports = { pool, resetDb, startApp, buildApp, seedWorld, migrate, dateOffset };
