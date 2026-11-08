const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { pool, resetDb, startApp, seedWorld, dateOffset } = require("./helpers");
const { audit } = require("../server/services/audit");

let app;
let w;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(async () => { await resetDb(); w = await seedWorld(); });

const count = async (table, where = "TRUE", params = []) =>
  (await pool.query(`SELECT COUNT(*)::int n FROM ${table} WHERE ${where}`, params)).rows[0].n;

// ---- no permanent deletion -----------------------------------------------------------
test("deleting a doctor deactivates; appointments and leaves are preserved", async () => {
  await app.call("POST", "/admin/doctor-leaves", { as: w.admin, body: { doctor_id: w.dA1, leave_date: "2030-01-01" } });
  const r = await app.call("POST", `/admin/delete-doctor/${w.dA1}`, { as: w.admin });
  assert.equal(r.status, 200);
  assert.equal(r.json.is_active, false);
  assert.equal(r.json.upcoming_appointments, 1);
  assert.equal(await count("doctors", "id = $1", [w.dA1]), 1);
  assert.equal(await count("appointments", "doctor_id = $1", [w.dA1]), 1);
  assert.equal(await count("doctor_leaves", "doctor_id = $1", [w.dA1]), 1);
  const { rows } = await pool.query("SELECT is_active, deactivated_at FROM doctors WHERE id = $1", [w.dA1]);
  assert.equal(rows[0].is_active, false);
  assert.ok(rows[0].deactivated_at);
});

test("deleting a hospital deactivates; doctors, appointments, history are preserved", async () => {
  const before = { d: await count("doctors"), a: await count("appointments") };
  const r = await app.call("POST", `/admin/delete-hospital/${w.hA}`, { as: w.admin });
  assert.equal(r.status, 200);
  assert.equal(await count("hospitals", "id = $1", [w.hA]), 1);
  assert.equal(await count("doctors"), before.d);
  assert.equal(await count("appointments"), before.a);
  assert.equal(await count("hospitals", "is_active"), 1);
});

test("deactivation is reversible and unknown ids are 404", async () => {
  await app.call("POST", `/admin/delete-doctor/${w.dA1}`, { as: w.admin });
  assert.equal((await app.call("POST", `/admin/reactivate-doctor/${w.dA1}`, { as: w.admin })).status, 200);
  assert.equal(await count("doctors", "is_active"), 3);
  await app.call("POST", `/admin/delete-hospital/${w.hA}`, { as: w.admin });
  assert.equal((await app.call("POST", `/admin/reactivate-hospital/${w.hA}`, { as: w.admin })).status, 200);
  assert.equal(await count("hospitals", "is_active"), 2);
  assert.equal((await app.call("POST", "/admin/delete-doctor/99999", { as: w.admin })).status, 404);
  assert.equal((await app.call("POST", "/admin/delete-hospital/99999", { as: w.admin })).status, 404);
});

test("deactivated doctor/hospital disappear from patient discovery and cannot be booked", async () => {
  const date = dateOffset(3);
  const bookBody = { name: "New Pat", mobile: "9876543210", date, doctor_id: w.dA1, hospital_id: w.hA, reason_for_visit: "cough" };
  await app.call("POST", `/admin/delete-doctor/${w.dA1}`, { as: w.admin });
  const docs = await app.call("GET", `/doctors/${w.hA}`, { as: w.patient });
  assert.deepEqual(docs.json.map((d) => d.id), [w.dA2]);
  assert.equal((await app.call("GET", `/doctor/${w.dA1}/slots?date=${date}`, { as: w.patient })).status, 404);
  assert.equal((await app.call("POST", "/book", { as: w.patient, body: bookBody })).status, 404);

  await app.call("POST", `/admin/delete-hospital/${w.hB}`, { as: w.admin });
  const cities = await app.call("GET", "/cities", { as: w.patient });
  assert.equal(cities.json[0].hospital_count, 1);
  assert.equal((await app.call("GET", `/hospital/${w.hB}/details`, { as: w.patient })).status, 404);
  // existing appointment of a deactivated doctor is still readable by its owner
  const mine = await app.call("GET", "/appointments/my", { as: w.patient });
  assert.equal(mine.json.upcoming.length + mine.json.past.length, 1);
});

// ---- existing patient/appointment functionality still works ---------------------------
test("regression: patient can browse, book, view and cancel an appointment", async () => {
  const date = dateOffset(3);
  const cities = await app.call("GET", "/cities", { as: w.patient });
  assert.equal(cities.status, 200);
  assert.equal(cities.json[0].hospital_count, 2);
  const hosp = await app.call("GET", `/hospitals/${w.cityId}`, { as: w.patient });
  assert.equal(hosp.json.length, 2);
  const docs = await app.call("GET", `/doctors/${w.hA}`, { as: w.patient });
  assert.equal(docs.json.length, 2);
  const slots = await app.call("GET", `/doctor/${w.dA1}/slots?date=${date}`, { as: w.patient });
  assert.equal(slots.status, 200);

  const body = { name: "Pat One", mobile: "9876543210", date, doctor_id: w.dA1, hospital_id: w.hA, reason_for_visit: "fever" };
  const booked = await app.call("POST", "/book", { as: w.patient, body });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
  const second = await app.call("POST", "/book", { as: w.patient2, body: { ...body, name: "Pat Two" } });
  assert.equal(second.status, 201);
  assert.notEqual(booked.json.token_number, second.json.token_number);

  const mine = await app.call("GET", "/appointments/my", { as: w.patient });
  assert.ok([...mine.json.upcoming, ...mine.json.past].some((a) => a.id === booked.json.id));
  const id = booked.json.id;
  // another patient cannot see or cancel it
  assert.equal((await app.call("GET", `/appointment/${id}`, { as: w.patient2 })).status, 404);
  assert.equal((await app.call("POST", `/appointment/${id}/cancel`, { as: w.patient2 })).status, 404);
  assert.equal((await app.call("POST", `/appointment/${id}/cancel`, { as: w.patient })).status, 200);
  assert.equal((await pool.query("SELECT status FROM appointments WHERE id = $1", [id])).rows[0].status, "cancelled");
  // cancelled appointment cannot be revived by staff
  assert.equal((await app.call("POST", `/admin/appointment/${id}/status`, { as: w.admin, body: { status: "booked" } })).status, 409);
});

// ---- audit logging -------------------------------------------------------------------
test("admin mutations are audited with actor, action, entity", async () => {
  await app.call("POST", `/admin/delete-doctor/${w.dA1}`, { as: w.admin });
  await app.call("POST", `/admin/appointment/${w.apptA2}/status`, { as: w.recepA, body: { status: "serving" } });
  await app.call("POST", `/admin/appointment/${w.apptA1}/visit-notes`, { as: w.docUserA1, body: { visit_notes: "PRIVATE TEXT" } });
  await app.call("POST", "/admin/add-city", { as: w.admin, body: { name: "Newtown" } });
  const { rows } = await pool.query("SELECT user_email, action, entity, entity_id, detail FROM audit_logs ORDER BY id");
  const actions = rows.map((r) => r.action);
  for (const a of ["doctor.deactivate", "appointment.status", "appointment.visit_notes", "city.create"]) {
    assert.ok(actions.includes(a), `missing ${a}: ${actions}`);
  }
  const deact = rows.find((r) => r.action === "doctor.deactivate");
  assert.equal(deact.user_email, "root@test.local");
  assert.equal(deact.entity_id, String(w.dA1));
  assert.ok(!rows.some((r) => (r.detail || "").includes("PRIVATE TEXT")), "clinical text must never be logged");
});

test("rejected (unauthorised) requests are not audited as successes", async () => {
  await app.call("POST", `/admin/delete-doctor/${w.dB1}`, { as: w.hospAdminA });
  assert.equal(await count("audit_logs"), 0);
});

test("audit() never breaks the caller by default, and strict mode propagates failure", async () => {
  await audit({ id: null, email: null }, "x.test", "thing", 1, { a: 1 });
  assert.equal(await count("audit_logs", "action = 'x.test'"), 1);
  const bad = { query: async () => { throw new Error("db down"); } };
  await audit(null, "x", "y", 1, null, { db: bad }); // swallowed (logged)
  await assert.rejects(audit(null, "x", "y", 1, null, { db: bad, strict: true }), /db down/);
});

test("audit rows in a rolled-back transaction roll back too", async () => {
  const c = await pool.connect();
  await c.query("BEGIN");
  await audit(null, "tx.rollback", "t", 1, null, { db: c, strict: true });
  await c.query("ROLLBACK");
  c.release();
  assert.equal(await count("audit_logs", "action = 'tx.rollback'"), 0);
});

test("audit log viewer is admin-only, paginated and filterable", async () => {
  for (let i = 0; i < 5; i++) await audit(null, "bulk.test", "thing", i);
  await audit(null, "other", "thing", 9);
  const page = await app.call("GET", "/admin/audit-logs?action=bulk.test&limit=2&page=2", { as: w.admin });
  assert.equal(page.status, 200);
  assert.equal(page.json.total, 5);
  assert.equal(page.json.items.length, 2);
  assert.equal((await app.call("GET", "/admin/audit-logs", { as: w.hospAdminA })).status, 403);
});

// ---- staff management ----------------------------------------------------------------
test("admin can assign staff roles; validation and protections hold", async () => {
  const doc = await app.call("POST", "/admin/staff", { as: w.admin, body: { email: "New.Doc@A.test", role: "doctor", doctor_id: w.dB1 } });
  assert.equal(doc.status, 201);
  assert.equal(doc.json.email, "new.doc@a.test");
  assert.equal(doc.json.hospital_id, w.hB); // derived from the doctor, not trusted from input
  // that doctor profile cannot be linked to a second account
  assert.equal((await app.call("POST", "/admin/staff", { as: w.admin, body: { email: "other@a.test", role: "doctor", doctor_id: w.dB1 } })).status, 409);
  assert.equal((await app.call("POST", "/admin/staff", { as: w.admin, body: { email: "bad", role: "doctor", doctor_id: w.dB1 } })).status, 400);
  assert.equal((await app.call("POST", "/admin/staff", { as: w.admin, body: { email: "z@a.test", role: "admin" } })).status, 400);
  assert.equal((await app.call("POST", "/admin/staff", { as: w.admin, body: { email: "z@a.test", role: "receptionist" } })).status, 400);
  assert.equal((await app.call("POST", "/admin/staff", { as: w.admin, body: { email: "root@test.local", role: "patient" } })).status, 403);
  assert.equal(await count("audit_logs", "action = 'staff.assign'"), 1);
  const list = await app.call("GET", "/admin/staff?q=new.doc", { as: w.admin });
  assert.equal(list.json.total, 1);
});

test("admin cannot deactivate themself; staff deactivation takes effect immediately", async () => {
  assert.equal((await app.call("POST", `/admin/staff/${w.admin}/deactivate`, { as: w.admin })).status, 403);
  assert.equal((await app.call("POST", `/admin/staff/${w.recepA}/deactivate`, { as: w.admin })).status, 200);
  assert.equal((await app.call("GET", "/admin/board-data", { as: w.recepA })).status, 403);
  assert.equal((await app.call("POST", `/admin/staff/${w.recepA}/reactivate`, { as: w.admin })).status, 200);
  assert.equal((await app.call("GET", "/admin/board-data", { as: w.recepA })).status, 200);
});
