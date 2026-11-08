const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { pool, resetDb, startApp, seedWorld, dateOffset } = require("./helpers");

let app;
let w;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(async () => { await resetDb(); w = await seedWorld(); });

const date = () => dateOffset(3);
const book = (as, extra = {}) =>
  app.call("POST", "/book", {
    as,
    body: { name: "Asha Rao", mobile: "9876543210", date: date(), doctor_id: w.dA1, hospital_id: w.hA, reason_for_visit: "fever", ...extra },
  });
const count = async (sql, p = []) => (await pool.query(sql, p)).rows[0].n;

// ---- linking + uniqueness ------------------------------------------------------------
test("booking creates a patient with a unique MRN and links the appointment", async () => {
  const r = await book(w.patient, { date_of_birth: "1990-05-01", gender: "female" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const patient = (await pool.query("SELECT * FROM patients WHERE id = $1", [r.json.patient_id])).rows[0];
  assert.match(patient.mrn, /^PC-\d+$/);
  assert.equal(patient.full_name, "Asha Rao");
  assert.equal(patient.relation, "self");
  assert.equal(patient.user_id, w.patient);
  assert.equal(patient.date_of_birth, "1990-05-01");
  assert.equal((await pool.query("SELECT patient_id FROM appointments WHERE id = $1", [r.json.id])).rows[0].patient_id, patient.id);
});

test("same person booking again reuses the record; MRNs are never reused or duplicated", async () => {
  const a = await book(w.patient);
  const b = await book(w.patient, { name: "  asha RAO " }); // case/space variations
  assert.equal(a.json.patient_id, b.json.patient_id);
  assert.equal(await count("SELECT COUNT(*)::int n FROM patients WHERE user_id = $1", [w.patient]), 1);
  const other = await book(w.patient, { name: "Ravi Rao" });
  assert.notEqual(other.json.patient_id, a.json.patient_id);
  const mrns = (await pool.query("SELECT mrn FROM patients")).rows.map((r) => r.mrn);
  assert.equal(new Set(mrns).size, mrns.length);
});

test("two accounts with the same name get separate records (no cross-account merging)", async () => {
  const a = await book(w.patient);
  const b = await book(w.patient2);
  assert.notEqual(a.json.patient_id, b.json.patient_id);
});

test("family-member bookings get their own linked record with the relation", async () => {
  const fm = (await pool.query("INSERT INTO family_members (user_id, name, relation) VALUES ($1,'Meera Rao','mother') RETURNING id", [w.patient])).rows[0].id;
  const r = await book(w.patient, { family_member_id: fm, name: undefined });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const p = (await pool.query("SELECT * FROM patients WHERE id = $1", [r.json.patient_id])).rows[0];
  assert.equal(p.full_name, "Meera Rao");
  assert.equal(p.relation, "mother");
  assert.equal(p.family_member_id, fm);
});

test("concurrent identical bookings never create duplicate patients", async () => {
  const results = await Promise.all([1, 2, 3, 4].map((slot) => book(w.patient, { slot_number: slot })));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.json)));
  assert.equal(await count("SELECT COUNT(*)::int n FROM patients WHERE user_id = $1", [w.patient]), 1);
  assert.equal(new Set(results.map((r) => r.json.patient_id)).size, 1);
});

test("booking can reuse a saved patient_id but never someone else's", async () => {
  const mine = (await app.call("POST", "/patients", { as: w.patient, body: { full_name: "Saved Person", phone: "9000000001" } })).json;
  const ok = await book(w.patient, { patient_id: mine.id, name: undefined });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.patient_id, mine.id);
  assert.equal((await book(w.patient2, { patient_id: mine.id })).status, 404);
});

// ---- patient API ---------------------------------------------------------------------
test("patient CRUD: register, duplicate refused, list, view, update, owner-only", async () => {
  const created = await app.call("POST", "/patients", {
    as: w.patient, body: { full_name: "Neha Joshi", date_of_birth: "1985-02-03", gender: "female", phone: "+91 98765 43210", email: "Neha@X.test", allergies: "penicillin" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.email, "neha@x.test");
  const dup = await app.call("POST", "/patients", { as: w.patient, body: { full_name: "neha joshi" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.patient.id, created.json.id);
  assert.equal((await app.call("GET", "/patients", { as: w.patient })).json.length, 1);
  assert.equal((await app.call("GET", `/patients/${created.json.id}`, { as: w.patient })).json.allergies, "penicillin");
  assert.equal((await app.call("GET", `/patients/${created.json.id}`, { as: w.patient2 })).status, 404);
  assert.equal((await app.call("POST", `/patients/${created.json.id}`, { as: w.patient2, body: { phone: "9111111111" } })).status, 404);
  const up = await app.call("POST", `/patients/${created.json.id}`, { as: w.patient, body: { phone: "9111111111", blood_group: "O+" } });
  assert.equal(up.json.phone, "9111111111");
  assert.equal(up.json.allergies, "penicillin", "unsupplied fields are untouched");
  assert.equal((await app.call("POST", `/patients/${created.json.id}`, { as: w.patient, body: {} })).status, 400);
  assert.equal((await app.call("GET", "/patients", { as: w.patient2 })).json.length, 0);
});

test("patient input validation", async () => {
  const bad = async (body) => assert.equal((await app.call("POST", "/patients", { as: w.patient, body })).status, 400, JSON.stringify(body));
  await bad({});
  await bad({ full_name: "A", date_of_birth: "nope" });
  await bad({ full_name: "A", date_of_birth: "2999-01-01" });
  await bad({ full_name: "A", date_of_birth: "1800-01-01" });
  await bad({ full_name: "A", gender: "x" });
  await bad({ full_name: "A", email: "bad" });
  await bad({ full_name: "A", phone: "abc" });
  await bad({ full_name: "x".repeat(121) });
  await bad({ full_name: "A", allergies: "x".repeat(1001) });
});

test("renaming into an existing identity is refused (409)", async () => {
  const a = (await app.call("POST", "/patients", { as: w.patient, body: { full_name: "One" } })).json;
  await app.call("POST", "/patients", { as: w.patient, body: { full_name: "Two" } });
  assert.equal((await app.call("POST", `/patients/${a.id}`, { as: w.patient, body: { full_name: "two" } })).status, 409);
});

test("appointment history per patient, including cancelled, owner-only", async () => {
  const a = await book(w.patient);
  await book(w.patient, { slot_number: 2 });
  await app.call("POST", `/appointment/${a.json.id}/cancel`, { as: w.patient });
  const h = await app.call("GET", `/patients/${a.json.patient_id}/appointments`, { as: w.patient });
  assert.equal(h.json.length, 2);
  assert.deepEqual(h.json.map((x) => x.status).sort(), ["booked", "cancelled"]);
  assert.equal(h.json[0].doctor_name, "Dr A1");
  assert.equal((await app.call("GET", `/patients/${a.json.patient_id}/appointments`, { as: w.patient2 })).status, 404);
});

// ---- staff access --------------------------------------------------------------------
test("staff see only patients within their scope; clinical details are doctor/admin only", async () => {
  const a = (await book(w.patient, { name: "Alpha Patient" })).json; // doctor A1 / hospital A
  const b = (await book(w.patient2, { name: "Beta Patient", doctor_id: w.dB1, hospital_id: w.hB })).json;
  await pool.query("UPDATE patients SET allergies = 'latex', medical_history = 'asthma' WHERE id = $1", [a.patient_id]);

  const namesFor = async (u, q = "") => (await app.call("GET", `/admin/patients${q}`, { as: u })).json.items.map((p) => p.full_name);
  assert.deepEqual(await namesFor(w.admin), ["Beta Patient", "Alpha Patient"]);
  assert.deepEqual(await namesFor(w.hospAdminA), ["Alpha Patient"]);
  assert.deepEqual(await namesFor(w.hospAdminB), ["Beta Patient"]);
  assert.deepEqual(await namesFor(w.docUserA1), ["Alpha Patient"]);
  assert.deepEqual(await namesFor(w.docUserA2), []);
  assert.deepEqual(await namesFor(w.admin, "?q=beta"), ["Beta Patient"]);
  assert.equal((await app.call("GET", "/admin/patients", { as: w.patient })).status, 403);
  assert.equal((await app.call("GET", "/admin/patients", { as: w.docUnlinked })).status, 403);

  assert.equal((await app.call("GET", `/admin/patients/${b.patient_id}`, { as: w.hospAdminA })).status, 404);
  assert.equal((await app.call("GET", `/admin/patients/${a.patient_id}`, { as: w.docUserA2 })).status, 404);
  const asDoctor = await app.call("GET", `/admin/patients/${a.patient_id}`, { as: w.docUserA1 });
  assert.equal(asDoctor.json.allergies, "latex");
  assert.equal(asDoctor.json.appointments.length, 1);
  const asReception = await app.call("GET", `/admin/patients/${a.patient_id}`, { as: w.recepA });
  assert.equal(asReception.status, 200);
  assert.equal(asReception.json.allergies, null);
  assert.equal(asReception.json.medical_history, null);
  assert.equal(await count("SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'patient.view'"), 2);
});

// ---- migration: legacy appointments are preserved and linked ----------------------------
test("migration 004 links legacy appointments to patients without losing or changing any row", async () => {
  const name = `pulsecare_mig_${process.pid}`;
  const admin = new Client({ connectionString: "postgresql://localhost/postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const c = new Client({ connectionString: `postgresql://localhost/${name}` });
  await c.connect();
  try {
    const dir = path.join(__dirname, "../db/migrations");
    const run = (f) => c.query(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const f of ["000_baseline.sql", "001_hms_core.sql", "002_lifecycle_rbac.sql", "003_catalog.sql"]) await run(f);
    await c.query("INSERT INTO cities (name) VALUES ('X')");
    await c.query("INSERT INTO hospitals (name, city_id, location) VALUES ('H', 1, 'l')");
    await c.query("INSERT INTO doctors (name, hospital_id) VALUES ('D', 1)");
    await c.query("INSERT INTO users (email, name) VALUES ('u1@x.test','U1'), ('u2@x.test','U2')");
    await c.query("INSERT INTO family_members (user_id, name, relation) VALUES (1, 'Kid One', 'son')");
    const ins = (u, n, tok, fm = null) =>
      c.query(`INSERT INTO appointments (user_id, user_name, mobile, doctor_id, hospital_id, appointment_date, token_number, slot_number, family_member_id, status)
               VALUES ($1,$2,'9999999999',1,1,'2030-01-01',$3,$3,$4,'completed')`, [u, n, tok, fm]);
    await ins(1, "Gaurav Kale", 1); await ins(1, " gaurav kale ", 2); await ins(1, "Kid One", 3, 1); await ins(2, "Gaurav Kale", 4);
    const before = (await c.query("SELECT id, user_id, user_name, mobile, token_number, status FROM appointments ORDER BY id")).rows;
    await run("004_patients_holds_payments.sql");
    const after = (await c.query("SELECT id, user_id, user_name, mobile, token_number, status FROM appointments ORDER BY id")).rows;
    assert.deepEqual(after, before, "existing appointment data unchanged");
    assert.equal((await c.query("SELECT COUNT(*)::int n FROM appointments WHERE patient_id IS NULL")).rows[0].n, 0);
    const patients = (await c.query("SELECT user_id, full_name, relation FROM patients ORDER BY id")).rows;
    assert.equal(patients.length, 3); // u1 self, u1 Kid One, u2 self
    assert.ok(patients.some((p) => p.full_name === "Kid One" && p.relation === "son"));
    const linked = (await c.query("SELECT DISTINCT patient_id FROM appointments WHERE id IN (1,2)")).rows;
    assert.equal(linked.length, 1, "spelling/case variants of the same person share one record");
    await run("004_patients_holds_payments.sql"); // idempotent
    assert.equal((await c.query("SELECT COUNT(*)::int n FROM patients")).rows[0].n, 3);
  } finally {
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
