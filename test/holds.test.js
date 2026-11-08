const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { pool, resetDb, startApp, seedWorld, dateOffset, useGateway } = require("./helpers");
const { releaseExpiredHolds } = require("../server/services/booking");

let app;
let w;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  useGateway();
});

const date = (n = 3) => dateOffset(n);
const book = (as, extra = {}) =>
  app.call("POST", "/book", {
    as,
    body: { name: "Asha Rao", mobile: "9876543210", date: date(), doctor_id: w.dA1, hospital_id: w.hA, reason_for_visit: "fever", slot_number: 3, ...extra },
  });
const setFee = (id, fee) => pool.query("UPDATE doctors SET consultation_fee = $2 WHERE id = $1", [id, fee]);
const slotsOf = async (as, d = date()) => (await app.call("GET", `/doctor/${w.dA1}/slots?date=${d}`, { as })).json;

// ---- free vs paid ----------------------------------------------------------------------
test("free consultation is confirmed immediately, with notification", async () => {
  const r = await book(w.patient);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.status, "booked");
  assert.equal(r.json.requires_payment, false);
  assert.equal(r.json.hold_expires_at, null);
  assert.equal(r.json.slot_start, "09:30");
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM notifications WHERE appointment_id = $1", [r.json.id])).rows[0].n, 1);
});

test("paid consultation becomes a time-limited hold; no confirmation until payment", async () => {
  await setFee(w.dA1, 500);
  const r = await book(w.patient);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.status, "pending_payment");
  assert.equal(r.json.requires_payment, true);
  assert.equal(Number(r.json.fee_amount), 500);
  const mins = (new Date(r.json.hold_expires_at) - Date.now()) / 60000;
  assert.ok(mins > 13 && mins <= 15.1, `hold should be ~15 min, got ${mins}`);
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM notifications WHERE appointment_id = $1", [r.json.id])).rows[0].n, 0);
});

test("paid booking is refused (503) while the payment gateway is not configured; no slot is held", async () => {
  await setFee(w.dA1, 500);
  useGateway({ configured: false });
  const r = await book(w.patient);
  assert.equal(r.status, 503);
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM appointments WHERE token_number = 2 AND doctor_id = $1", [w.dA1])).rows[0].n, 0);
});

test("fee is snapshotted: later fee changes do not alter an existing booking", async () => {
  await setFee(w.dA1, 500);
  const r = await book(w.patient);
  await setFee(w.dA1, 900);
  assert.equal(Number((await pool.query("SELECT fee_amount FROM appointments WHERE id = $1", [r.json.id])).rows[0].fee_amount), 500);
});

// ---- no double booking --------------------------------------------------------------------
test("a held slot cannot be booked by another patient; other slots stay open", async () => {
  await setFee(w.dA1, 500);
  assert.equal((await book(w.patient)).status, 201);
  const clash = await book(w.patient2);
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /taken/i);
  assert.equal((await book(w.patient2, { slot_number: 4 })).status, 201);
  const slots = await slotsOf(w.patient2);
  const s3 = slots.slots.find((s) => s.slotNumber === 3);
  assert.equal(s3.isBooked, true);
  assert.equal(s3.isAvailable, false);
});

test("race: many simultaneous requests for one slot yield exactly one booking", async () => {
  const users = [w.patient, w.patient2, w.hospAdminA, w.recepA, w.docUserA2, w.docUserA1];
  const results = await Promise.all(users.map((u, i) => book(u, { name: `Racer ${i}`, slot_number: 5 })));
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
  const { rows } = await pool.query("SELECT COUNT(*)::int n FROM appointments WHERE doctor_id = $1 AND slot_number = 5 AND status <> 'cancelled'", [w.dA1]);
  assert.equal(rows[0].n, 1);
});

test("the database itself rejects two active appointments in one slot", async () => {
  await book(w.patient);
  await assert.rejects(
    pool.query(`INSERT INTO appointments (user_id, user_name, mobile, doctor_id, hospital_id, appointment_date, token_number, slot_number, status)
                VALUES ($1,'x','1',$2,$3,$4,99,3,'booked')`, [w.patient2, w.dA1, w.hA, date()]),
    /uq_appointments_active_slot|duplicate key/
  );
});

test("held slots count toward the doctor's daily limit", async () => {
  await setFee(w.dA1, 500);
  await pool.query("UPDATE doctors SET max_patients_per_day = 1 WHERE id = $1", [w.dA1]);
  assert.equal((await book(w.patient)).status, 201);
  assert.equal((await book(w.patient2, { slot_number: 4 })).status, 409);
});

// ---- expiry ------------------------------------------------------------------------------
test("expired hold is released automatically and the slot becomes bookable again", async () => {
  await setFee(w.dA1, 500);
  const held = await book(w.patient);
  await pool.query("UPDATE appointments SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [held.json.id]);
  const slots = await slotsOf(w.patient2); // lazy release on read
  assert.equal(slots.slots.find((s) => s.slotNumber === 3).isAvailable, true);
  const row = (await pool.query("SELECT status, cancel_reason FROM appointments WHERE id = $1", [held.json.id])).rows[0];
  assert.deepEqual(row, { status: "cancelled", cancel_reason: "hold_expired" });
  const again = await book(w.patient2);
  assert.equal(again.status, 201);
  assert.equal(again.json.status, "pending_payment");
});

test("booking itself releases an expired hold on the same slot", async () => {
  await setFee(w.dA1, 500);
  const held = await book(w.patient);
  await pool.query("UPDATE appointments SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [held.json.id]);
  assert.equal((await book(w.patient2)).status, 201);
});

test("sweeper releases only expired unpaid holds", async () => {
  await setFee(w.dA1, 500);
  const expired = (await book(w.patient)).json.id;
  const live = (await book(w.patient2, { slot_number: 4 })).json.id;
  const free = (await (async () => { await setFee(w.dA1, 0); return book(w.patient, { slot_number: 6 }); })()).json.id;
  await pool.query("UPDATE appointments SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [expired]);
  const released = await releaseExpiredHolds(pool);
  assert.deepEqual(released, [expired]);
  const statuses = Object.fromEntries((await pool.query("SELECT id, status FROM appointments WHERE id = ANY($1)", [[expired, live, free]])).rows.map((r) => [r.id, r.status]));
  assert.deepEqual(statuses, { [expired]: "cancelled", [live]: "pending_payment", [free]: "booked" });
  assert.deepEqual(await releaseExpiredHolds(pool), [], "idempotent");
});

test("patient can abandon a held booking: slot is freed at once", async () => {
  await setFee(w.dA1, 500);
  const held = await book(w.patient);
  assert.equal((await app.call("POST", `/appointment/${held.json.id}/cancel`, { as: w.patient })).status, 200);
  assert.equal((await book(w.patient2)).status, 201);
});

test("held bookings do not appear on the doctor's queue board", async () => {
  await setFee(w.dA1, 500);
  await book(w.patient, { date: dateOffset(0), slot_number: 1 }).catch(() => {});
  await pool.query(`INSERT INTO appointments (user_id, user_name, mobile, doctor_id, hospital_id, appointment_date, token_number, slot_number, status)
                    VALUES ($1,'Held Person','1',$2,$3,CURRENT_DATE,50,50,'pending_payment')`, [w.patient2, w.dA1, w.hA]);
  const board = await app.call("GET", `/doctor/${w.dA1}/today-data`, { as: w.docUserA1 });
  assert.ok(!board.json.appointments.some((a) => a.user_name === "Held Person"));
});

// ---- date / time rules -----------------------------------------------------------------------
test("cannot book in the past, an invalid date, or beyond the advance window", async () => {
  assert.equal((await book(w.patient, { date: dateOffset(-1) })).status, 400);
  assert.equal((await book(w.patient, { date: "2030-02-31" })).status, 400);
  assert.equal((await book(w.patient, { date: "tomorrow" })).status, 400);
  assert.equal((await book(w.patient, { date: dateOffset(400) })).status, 400);
  assert.equal((await app.call("GET", `/doctor/${w.dA1}/slots?date=${dateOffset(-2)}`, { as: w.patient })).status, 400);
});

test("cannot book a time earlier today; the slot list marks it unavailable", async () => {
  await pool.query("DELETE FROM appointments WHERE doctor_id = $1", [w.dA1]);
  await pool.query("UPDATE doctors SET available_from = '00:00', available_to = '00:15' WHERE id = $1", [w.dA1]);
  const r = await book(w.patient, { date: dateOffset(0), slot_number: 1 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /passed/);
  const list = (await app.call("GET", `/doctor/${w.dA1}/slots?date=${dateOffset(0)}`, { as: w.patient })).json;
  assert.equal(list.slots[0].isAvailable, false);
  assert.match(list.slots[0].unavailableReason, /passed/);
});

test("slot must exist in the doctor's schedule and inside hospital operating hours", async () => {
  assert.equal((await book(w.patient, { slot_number: 999 })).status, 400);
  assert.equal((await book(w.patient, { slot_number: "abc" })).status, 400);
  await pool.query("UPDATE hospitals SET opens_at = '10:00', closes_at = '11:00' WHERE id = $1", [w.hA]);
  const early = await book(w.patient, { slot_number: 1 }); // 09:00
  assert.equal(early.status, 400);
  assert.match(early.json.error, /operating hours/);
  const ok = await book(w.patient, { slot_number: 5 }); // 10:00
  assert.equal(ok.status, 201);
  const list = await slotsOf(w.patient2);
  assert.equal(list.slots.filter((s) => s.isAvailable).length, 3, "only 10:00-11:00 slots remain (one taken)");
  assert.equal(list.nextSlot.startTime, "10:15");
});

test("without a requested slot the earliest free slot is assigned", async () => {
  const a = await book(w.patient, { slot_number: undefined });
  const b = await book(w.patient2, { slot_number: undefined });
  assert.equal(a.json.slot_start, "09:00");
  assert.equal(b.json.slot_start, "09:15");
});

test("doctor leave and weekly off-days still block booking", async () => {
  await pool.query("INSERT INTO doctor_leaves (doctor_id, leave_date, reason) VALUES ($1,$2,'conference')", [w.dA1, date()]);
  assert.equal((await book(w.patient)).status, 400);
  await pool.query("DELETE FROM doctor_leaves");
  const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(`${date()}T12:00:00`).getDay()];
  await pool.query("UPDATE doctors SET unavailable_days = $2 WHERE id = $1", [w.dA1, day]);
  assert.equal((await book(w.patient)).status, 400);
});

test("rescheduling lets the patient pick a new exact time; held bookings cannot be rescheduled", async () => {
  const a = await book(w.patient);
  const r = await app.call("POST", `/appointment/${a.json.id}/reschedule`, { as: w.patient, body: { date: date(5), slot_number: 7 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = (await pool.query("SELECT TO_CHAR(slot_start,'HH24:MI') s, slot_number FROM appointments WHERE id = $1", [a.json.id])).rows[0];
  assert.deepEqual(row, { s: "10:30", slot_number: 7 });
  assert.equal((await app.call("POST", `/appointment/${a.json.id}/reschedule`, { as: w.patient, body: { date: dateOffset(-1) } })).status, 400);
  const b = await book(w.patient2, { slot_number: 8, date: date(5) });
  assert.equal((await app.call("POST", `/appointment/${a.json.id}/reschedule`, { as: w.patient, body: { date: date(5), slot_number: 8 } })).status, 409);
  await setFee(w.dA2, 500);
  const held = await book(w.patient2, { doctor_id: w.dA2, slot_number: 2 });
  assert.equal(held.json.status, "pending_payment");
  assert.equal((await app.call("POST", `/appointment/${held.json.id}/reschedule`, { as: w.patient2, body: { date: date(6) } })).status, 404);
  assert.ok(b.json.id);
});
