const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { pool, resetDb, startApp, seedWorld } = require("./helpers");

let app;
let w;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(async () => { await resetDb(); w = await seedWorld(); });

// ---- authentication gate -------------------------------------------------------------
test("unauthenticated requests get 401 on staff and patient APIs", async () => {
  for (const url of ["/admin/appointments", "/admin/board-data", `/doctor/${w.dA1}/today-data`, "/cities"]) {
    assert.equal((await app.call("GET", url)).status, 401, url);
  }
});

test("deactivated accounts are rejected everywhere", async () => {
  assert.equal((await app.call("GET", "/admin/board-data", { as: w.inactiveStaff })).status, 403);
  await pool.query("UPDATE users SET is_active = FALSE WHERE id = $1", [w.patient]);
  assert.equal((await app.call("GET", "/cities", { as: w.patient })).status, 403);
});

test("patients cannot reach any staff endpoint", async () => {
  for (const [m, u] of [
    ["GET", "/admin/stats"], ["GET", "/admin/appointments"], ["GET", "/admin/board-data"],
    ["GET", `/doctor/${w.dA1}/today-data`], ["GET", "/admin/staff"], ["GET", "/admin/audit-logs"],
    ["POST", `/admin/appointment/${w.apptA1}/status`], ["POST", `/admin/appointment/${w.apptA1}/visit-notes`],
  ]) {
    assert.equal((await app.call(m, u, { as: w.patient, body: {} })).status, 403, `${m} ${u}`);
  }
});

// ---- doctor-level authorization ------------------------------------------------------
test("a doctor sees only their own board", async () => {
  const own = await app.call("GET", `/doctor/${w.dA1}/today-data`, { as: w.docUserA1 });
  assert.equal(own.status, 200);
  assert.equal(own.json.appointments.length, 1);
  for (const other of [w.dA2, w.dB1]) {
    assert.equal((await app.call("GET", `/doctor/${other}/today-data`, { as: w.docUserA1 })).status, 404);
  }
});

test("a doctor's board-data and appointment list contain only their patients", async () => {
  const board = await app.call("GET", "/admin/board-data", { as: w.docUserA1 });
  assert.deepEqual(board.json.map((d) => d.doctor_id), [w.dA1]);
  const list = await app.call("GET", "/admin/appointments", { as: w.docUserA1 });
  assert.deepEqual(list.json.map((a) => a.id), [w.apptA1]);
});

test("a doctor cannot widen scope through query filters", async () => {
  const list = await app.call("GET", `/admin/appointments?doctor=${w.dB1}&hospital=${w.hB}`, { as: w.docUserA1 });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, []);
});

test("a doctor can write notes only on their own appointments", async () => {
  const ok = await app.call("POST", `/admin/appointment/${w.apptA1}/visit-notes`, {
    as: w.docUserA1, body: { visit_notes: "BP normal" },
  });
  assert.equal(ok.status, 200);
  for (const other of [w.apptA2, w.apptB1]) {
    const r = await app.call("POST", `/admin/appointment/${other}/visit-notes`, {
      as: w.docUserA1, body: { visit_notes: "hijack" },
    });
    assert.equal(r.status, 404);
  }
  const { rows } = await pool.query("SELECT visit_notes FROM appointments WHERE id = $1", [w.apptA2]);
  assert.equal(rows[0].visit_notes, "secret note");
});

test("a doctor can change status only on their own appointments", async () => {
  assert.equal((await app.call("POST", `/admin/appointment/${w.apptA1}/status`, { as: w.docUserA1, body: { status: "serving" } })).status, 200);
  assert.equal((await app.call("POST", `/admin/appointment/${w.apptA2}/status`, { as: w.docUserA1, body: { status: "serving" } })).status, 404);
});

test("a doctor account not linked to a doctor profile has no access", async () => {
  assert.equal((await app.call("GET", "/admin/board-data", { as: w.docUnlinked })).status, 403);
  assert.equal((await app.call("GET", "/admin/appointments", { as: w.docUnlinked })).status, 403);
  assert.equal((await app.call("GET", `/doctor/${w.dA1}/today-data`, { as: w.docUnlinked })).status, 404);
});

// ---- hospital-level authorization ----------------------------------------------------
test("hospital admin / receptionist see only their hospital", async () => {
  for (const u of [w.hospAdminA, w.recepA]) {
    const list = await app.call("GET", "/admin/appointments", { as: u });
    assert.deepEqual(list.json.map((a) => a.id).sort(), [w.apptA1, w.apptA2].sort());
    const board = await app.call("GET", "/admin/board-data", { as: u });
    assert.deepEqual(board.json.map((d) => d.doctor_id).sort(), [w.dA1, w.dA2].sort());
    assert.equal((await app.call("GET", `/doctor/${w.dB1}/today-data`, { as: u })).status, 404);
    assert.equal((await app.call("POST", `/admin/appointment/${w.apptB1}/status`, { as: u, body: { status: "serving" } })).status, 404);
  }
});

test("receptionist can move the queue but cannot read or write clinical notes", async () => {
  assert.equal((await app.call("POST", `/admin/appointment/${w.apptA1}/status`, { as: w.recepA, body: { status: "serving" } })).status, 200);
  assert.equal((await app.call("POST", `/admin/appointment/${w.apptA1}/visit-notes`, { as: w.recepA, body: { visit_notes: "x" } })).status, 403);
  const list = await app.call("GET", "/admin/appointments", { as: w.recepA });
  assert.ok(list.json.every((a) => a.visit_notes === null));
  const board = await app.call("GET", "/admin/board-data", { as: w.hospAdminA });
  assert.ok(board.json.flatMap((d) => d.appointments).every((a) => a.visit_notes === null));
});

test("hospital admin cannot touch another hospital's doctors", async () => {
  const body = { name: "X", specialization: "G", department_id: w.depId, hospital_id: w.hB, available_from: "09:00", available_to: "12:00" };
  assert.equal((await app.call("POST", "/admin/add-doctor", { as: w.hospAdminA, body })).status, 403);
  assert.equal((await app.call("POST", `/admin/update-doctor/${w.dB1}`, { as: w.hospAdminA, body: { ...body, hospital_id: w.hA } })).status, 404);
  // moving own doctor to another hospital is also refused
  assert.equal((await app.call("POST", `/admin/update-doctor/${w.dA1}`, { as: w.hospAdminA, body })).status, 404);
  assert.equal((await app.call("POST", `/admin/delete-doctor/${w.dB1}`, { as: w.hospAdminA })).status, 404);
  assert.equal((await app.call("POST", "/admin/doctor-leaves", { as: w.hospAdminA, body: { doctor_id: w.dB1, leave_date: "2030-01-01" } })).status, 404);
  const docs = await app.call("GET", "/admin/doctors", { as: w.hospAdminA });
  assert.deepEqual(docs.json.map((d) => d.id).sort(), [w.dA1, w.dA2].sort());
  const ok = await app.call("POST", "/admin/add-doctor", { as: w.hospAdminA, body: { ...body, hospital_id: w.hA } });
  assert.equal(ok.status, 201);
});

test("global configuration is admin-only", async () => {
  for (const u of [w.hospAdminA, w.recepA, w.docUserA1]) {
    assert.equal((await app.call("GET", "/admin/stats", { as: u })).status, 403);
    assert.equal((await app.call("POST", "/admin/add-hospital", { as: u, body: {} })).status, 403);
    assert.equal((await app.call("POST", `/admin/delete-hospital/${w.hA}`, { as: u })).status, 403);
    assert.equal((await app.call("POST", "/admin/staff", { as: u, body: { email: "a@b.co", role: "doctor" } })).status, 403);
  }
  assert.equal((await app.call("GET", "/admin/stats", { as: w.admin })).status, 200);
});

test("global admin sees everything; invalid ids and dates are 400, not 500", async () => {
  const list = await app.call("GET", "/admin/appointments", { as: w.admin });
  assert.equal(list.json.length, 3);
  assert.equal((await app.call("GET", "/admin/appointments?date=nope", { as: w.admin })).status, 400);
  assert.equal((await app.call("GET", "/admin/appointments?doctor=abc", { as: w.admin })).status, 400);
  assert.equal((await app.call("POST", "/admin/appointment/abc/status", { as: w.admin, body: { status: "serving" } })).status, 400);
});

test("CSV export neutralises spreadsheet formulas", async () => {
  await pool.query("UPDATE appointments SET user_name = '=HYPERLINK(\"http://evil\")' WHERE id = $1", [w.apptA1]);
  const csv = await app.call("GET", "/admin/appointments/export", { as: w.admin });
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes(`"'=HYPERLINK(`));
  assert.equal((await app.call("GET", "/admin/appointments/export", { as: w.recepA })).status, 403);
});
