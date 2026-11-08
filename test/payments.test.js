const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { pool, resetDb, startApp, seedWorld, dateOffset, useGateway, signCheckout, signWebhook, KEYS } = require("./helpers");

let app;
let w;
let gw;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  gw = useGateway();
  await pool.query("UPDATE doctors SET consultation_fee = 500 WHERE id = $1", [w.dA1]);
  await pool.query("UPDATE hospitals SET address = '1 Main Rd', contact_phone = '022-555', email = 'care@alpha.test' WHERE id = $1", [w.hA]);
});

const day = (n = 3) => dateOffset(n);
const book = (as = w.patient, extra = {}) =>
  app.call("POST", "/book", {
    as,
    body: { name: "Asha Rao", mobile: "9876543210", date: day(), doctor_id: w.dA1, hospital_id: w.hA, reason_for_visit: "fever", slot_number: 3, ...extra },
  });
const order = (as, appointment_id, extra = {}) => app.call("POST", "/payments/order", { as, body: { appointment_id, ...extra } });
const verify = (as, o, payId = "pay_1", sig) =>
  app.call("POST", "/payments/verify", {
    as, body: { razorpay_order_id: o, razorpay_payment_id: payId, razorpay_signature: sig ?? signCheckout(o, payId) },
  });
const row = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const status = async (id) => (await row("SELECT status FROM appointments WHERE id = $1", [id])).status;
const webhook = (event, id, secret = KEYS.webhook) => {
  const raw = JSON.stringify(event);
  return app.call("POST", "/payments/webhook", {
    raw, headers: { "x-razorpay-signature": signWebhook(raw, secret), "x-razorpay-event-id": id },
  });
};
async function heldAndOrdered(as = w.patient) {
  const b = (await book(as)).json;
  const o = (await order(as, b.id)).json;
  return { appt: b, order: o };
}

// ---- happy path: book -> order -> verify -> receipt ------------------------------------------
test("full journey: hold, order, verified payment, confirmed appointment, receipt", async () => {
  const b = (await book()).json;
  assert.equal(b.status, "pending_payment");
  assert.equal((await app.call("GET", `/receipts/${b.id}`, { as: w.patient })).status, 404, "no receipt before payment");

  const o = await order(w.patient, b.id);
  assert.equal(o.status, 201, JSON.stringify(o.json));
  assert.equal(o.json.amount, 500);
  assert.equal(o.json.amount_paise, 50000);
  assert.equal(o.json.key_id, KEYS.id);
  assert.ok(!JSON.stringify(o.json).includes(KEYS.secret), "key secret must never be sent to the browser");
  assert.equal(gw.orders[0].amountPaise, 50000);
  assert.equal(await status(b.id), "pending_payment", "creating an order confirms nothing");

  const v = await verify(w.patient, o.json.order_id, "pay_ok");
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.status, "paid");
  assert.equal(await status(b.id), "booked");
  const pay = await row("SELECT * FROM appointment_payments WHERE appointment_id = $1", [b.id]);
  assert.equal(pay.status, "paid");
  assert.equal(pay.gateway_payment_id, "pay_ok");
  assert.ok(pay.verified_at && pay.paid_at);
  assert.equal(Number(pay.amount), 500);
  assert.equal((await row("SELECT COUNT(*)::int n FROM notifications WHERE appointment_id = $1", [b.id])).n, 1);
  assert.equal(b.slot_start, "09:30");

  const rc = await app.call("GET", `/receipts/${b.id}`, { as: w.patient });
  assert.equal(rc.status, 200);
  assert.match(rc.json.receipt_no, /^RC-\d+$/);
  assert.equal(rc.json.hospital.name, "Alpha");
  assert.equal(rc.json.doctor.name, "Dr A1");
  assert.equal(rc.json.patient.name, "Asha Rao");
  assert.match(rc.json.patient.mrn, /^PC-\d+$/);
  assert.equal(rc.json.appointment.date, day());
  assert.equal(rc.json.appointment.time, "9:30 AM");
  assert.equal(rc.json.appointment.token_number, b.token_number);
  assert.equal(rc.json.payment.amount, 500);
  assert.equal(rc.json.payment.status, "PAID");
  assert.equal(rc.json.payment.transaction_id, "pay_ok");

  const mine = await app.call("GET", "/payments/my", { as: w.patient });
  assert.equal(mine.json.length, 1);
  assert.equal(mine.json[0].receipt_no, rc.json.receipt_no);
});

test("PDF receipt is a real PDF, attachment, and only for paid appointments", async () => {
  const { appt, order: o } = await heldAndOrdered();
  assert.equal((await app.call("GET", `/receipts/${appt.id}/pdf`, { as: w.patient })).status, 404);
  await verify(w.patient, o.order_id);
  const pdf = await app.call("GET", `/receipts/${appt.id}/pdf`, { as: w.patient });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), /attachment; filename="RC-\d+\.pdf"/);
  assert.equal(pdf.buf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.buf.length > 1500);
  assert.equal(pdf.buf.subarray(-6).toString().includes("%%EOF"), true);
});

test("printable HTML receipt shows the booking and escapes patient-controlled text", async () => {
  const { appt, order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id);
  await pool.query("UPDATE patients SET full_name = $1 WHERE id = $2", ['<img src=x onerror=alert(1)>', appt.patient_id]);
  const html = await app.call("GET", `/receipts/${appt.id}/print`, { as: w.patient });
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  assert.ok(html.text.includes("Alpha") && html.text.includes("Dr A1") && html.text.includes("9:30 AM") && html.text.includes("₹500.00"));
  assert.ok(!html.text.includes("<img src=x"), "must be HTML-escaped");
  assert.ok(html.text.includes("&lt;img src=x"));
  assert.match(html.headers.get("content-security-policy"), /default-src 'none'/);
});

test("receipts are private: other patients 404, scoped staff allowed, other hospitals' staff 404", async () => {
  const { appt, order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id);
  const url = `/receipts/${appt.id}`;
  assert.equal((await app.call("GET", url, { as: w.patient2 })).status, 404);
  assert.equal((await app.call("GET", url + "/pdf", { as: w.patient2 })).status, 404);
  assert.equal((await app.call("GET", url, { as: w.hospAdminA })).status, 200);
  assert.equal((await app.call("GET", url, { as: w.docUserA1 })).status, 200);
  assert.equal((await app.call("GET", url, { as: w.hospAdminB })).status, 404);
  assert.equal((await app.call("GET", url, { as: w.docUserA2 })).status, 404);
  assert.equal((await app.call("GET", url)).status, 401);
});

// ---- never trust the client ------------------------------------------------------------------
test("forged or wrong signature is rejected: appointment stays unconfirmed, no receipt", async () => {
  const { appt, order: o } = await heldAndOrdered();
  assert.equal((await verify(w.patient, o.order_id, "pay_x", "deadbeef")).status, 400);
  assert.equal((await verify(w.patient, o.order_id, "pay_x", signCheckout(o.order_id, "pay_x", "wrong-secret"))).status, 400);
  assert.equal((await verify(w.patient, o.order_id, "pay_other", signCheckout(o.order_id, "pay_x"))).status, 400, "signature bound to payment id");
  assert.equal((await app.call("POST", "/payments/verify", { as: w.patient, body: { razorpay_order_id: o.order_id } })).status, 400);
  assert.equal(await status(appt.id), "pending_payment");
  assert.equal((await row("SELECT status FROM appointment_payments WHERE appointment_id = $1", [appt.id])).status, "created");
  assert.equal((await row("SELECT COUNT(*)::int n FROM receipts")).n, 0);
  assert.ok((await row("SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'payment.verify_failed'")).n >= 3);
});

test("a valid signature for someone else's order is refused", async () => {
  const { order: o } = await heldAndOrdered();
  assert.equal((await verify(w.patient2, o.order_id)).status, 404);
  assert.equal((await order(w.patient2, (await row("SELECT id FROM appointments WHERE user_id = $1", [w.patient])).id)).status, 404);
});

test("the client cannot choose the amount", async () => {
  const b = (await book()).json;
  const o = await order(w.patient, b.id, { amount: 1, amount_paise: 100 });
  assert.equal(o.json.amount, 500);
  assert.equal(gw.orders[0].amountPaise, 50000);
});

test("order is idempotent per appointment (retry reuses it); free or confirmed appointments need none", async () => {
  const b = (await book()).json;
  const o1 = (await order(w.patient, b.id)).json;
  const o2 = (await order(w.patient, b.id)).json;
  assert.equal(o1.order_id, o2.order_id);
  assert.equal(gw.orders.length, 1);
  await verify(w.patient, o1.order_id);
  assert.equal((await order(w.patient, b.id)).status, 409);
  await pool.query("UPDATE doctors SET consultation_fee = 0 WHERE id = $1", [w.dA1]);
  const free = (await book(w.patient2, { slot_number: 6 })).json;
  assert.equal((await order(w.patient2, free.id)).status, 409);
});

test("gateway not configured: order creation is a clear 503", async () => {
  const b = (await book()).json;
  useGateway({ configured: false });
  assert.equal((await order(w.patient, b.id)).status, 503);
});

// ---- failure + retry -------------------------------------------------------------------------
test("payment failure does not confirm; retrying the same order then succeeds", async () => {
  const { appt, order: o } = await heldAndOrdered();
  const ev = { event: "payment.failed", payload: { payment: { entity: { id: "pay_f", order_id: o.order_id, error_description: "card declined" } } } };
  assert.equal((await webhook(ev, "evt_f1")).status, 200);
  const p = await row("SELECT status, attempts, failure_reason FROM appointment_payments WHERE gateway_order_id = $1", [o.order_id]);
  assert.deepEqual(p, { status: "created", attempts: 1, failure_reason: "card declined" });
  assert.equal(await status(appt.id), "pending_payment");
  assert.equal((await row("SELECT COUNT(*)::int n FROM receipts")).n, 0);

  assert.equal((await order(w.patient, appt.id)).json.order_id, o.order_id, "retry reuses the order");
  assert.equal((await verify(w.patient, o.order_id, "pay_retry")).status, 200);
  assert.equal(await status(appt.id), "booked");
  assert.equal((await row("SELECT failure_reason FROM appointment_payments WHERE gateway_order_id = $1", [o.order_id])).failure_reason, null);
});

// ---- webhooks --------------------------------------------------------------------------------
test("webhook with a bad or missing signature is rejected and changes nothing", async () => {
  const { appt, order: o } = await heldAndOrdered();
  const ev = { event: "payment.captured", payload: { payment: { entity: { id: "pay_w", order_id: o.order_id, method: "upi" } } } };
  assert.equal((await webhook(ev, "evt_bad", "wrong-webhook-secret")).status, 400);
  assert.equal((await app.call("POST", "/payments/webhook", { body: ev, headers: { "x-razorpay-event-id": "evt_nosig" } })).status, 400);
  assert.equal(await status(appt.id), "pending_payment");
  assert.equal((await row("SELECT COUNT(*)::int n FROM payment_events")).n, 0);
});

test("captured webhook confirms the booking even if the browser never returned; duplicates are ignored", async () => {
  const { appt, order: o } = await heldAndOrdered();
  const ev = { event: "payment.captured", payload: { payment: { entity: { id: "pay_w", order_id: o.order_id, method: "upi" } } } };
  assert.equal((await webhook(ev, "evt_1")).json.status, "ok");
  assert.equal(await status(appt.id), "booked");
  assert.equal((await row("SELECT method FROM appointment_payments WHERE gateway_order_id = $1", [o.order_id])).method, "upi");
  assert.equal((await webhook(ev, "evt_1")).json.status, "duplicate_ignored");
  assert.equal((await webhook(ev, "evt_2")).status, 200, "same payment re-delivered under a new event id is harmless");
  assert.equal((await row("SELECT COUNT(*)::int n FROM receipts")).n, 1);
  assert.equal((await row("SELECT COUNT(*)::int n FROM notifications WHERE appointment_id = $1", [appt.id])).n, 1);
});

test("webhook and browser verify racing each other confirm exactly once", async () => {
  const { appt, order: o } = await heldAndOrdered();
  const ev = { event: "payment.captured", payload: { payment: { entity: { id: "pay_race", order_id: o.order_id } } } };
  const results = await Promise.all([webhook(ev, "evt_r1"), verify(w.patient, o.order_id, "pay_race"), webhook(ev, "evt_r2"), verify(w.patient, o.order_id, "pay_race")]);
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(await status(appt.id), "booked");
  assert.equal((await row("SELECT COUNT(*)::int n FROM receipts")).n, 1);
  assert.equal((await row("SELECT COUNT(*)::int n FROM appointment_payments WHERE status = 'paid'")).n, 1);
  assert.equal((await row("SELECT COUNT(*)::int n FROM notifications WHERE appointment_id = $1", [appt.id])).n, 1);
});

test("unknown order in a webhook is retried by the gateway (event not consumed)", async () => {
  const ev = { event: "payment.captured", payload: { payment: { entity: { id: "pay_z", order_id: "order_unknown" } } } };
  assert.equal((await webhook(ev, "evt_unknown")).status, 404);
  assert.equal((await row("SELECT COUNT(*)::int n FROM payment_events")).n, 0);
});

// ---- expiry vs payment -----------------------------------------------------------------------
test("order after the hold expired is refused (410); expired hold frees the slot", async () => {
  const b = (await book()).json;
  await pool.query("UPDATE appointments SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [b.id]);
  const o = await order(w.patient, b.id);
  assert.ok([409, 410].includes(o.status), String(o.status));
  assert.equal(await status(b.id), "cancelled");
});

test("payment arriving just after expiry (slot still free) reinstates the booking", async () => {
  const { appt, order: o } = await heldAndOrdered();
  await pool.query("UPDATE appointments SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [appt.id]);
  await app.call("GET", `/doctor/${w.dA1}/slots?date=${day()}`, { as: w.patient2 }); // triggers release
  assert.equal(await status(appt.id), "cancelled");
  const v = await verify(w.patient, o.order_id, "pay_late");
  assert.equal(v.status, 200);
  assert.equal(v.json.outcome, "reinstated");
  assert.equal(await status(appt.id), "booked");
  assert.equal((await row("SELECT COUNT(*)::int n FROM receipts")).n, 1);
});

test("payment after expiry when someone else took the slot is refunded automatically; no receipt", async () => {
  const { appt, order: o } = await heldAndOrdered();
  await pool.query("UPDATE appointments SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [appt.id]);
  await pool.query("UPDATE doctors SET consultation_fee = 0 WHERE id = $1", [w.dA1]);
  assert.equal((await book(w.patient2)).status, 201, "slot reused by another patient");
  const v = await verify(w.patient, o.order_id, "pay_late2");
  assert.equal(v.status, 409);
  assert.equal(v.json.outcome, "refund_required");
  assert.equal(await status(appt.id), "cancelled");
  assert.equal((await row("SELECT COUNT(*)::int n FROM receipts")).n, 0);
  assert.equal(gw.refunds.length, 1);
  assert.equal(gw.refunds[0].paymentId, "pay_late2");
  assert.equal(gw.refunds[0].amountPaise, 50000);
  assert.equal((await row("SELECT status FROM appointment_payments WHERE gateway_order_id = $1", [o.order_id])).status, "refunded");
});

// ---- cancellation + refunds ----------------------------------------------------------------
test("cancelling a paid appointment well in advance refunds in full; receipt then shows REFUNDED", async () => {
  const { appt, order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id, "pay_c");
  const c = await app.call("POST", `/appointment/${appt.id}/cancel`, { as: w.patient });
  assert.equal(c.status, 200);
  assert.equal(c.json.refund.status, "processed");
  assert.equal(Number(c.json.refund.amount), 500);
  assert.equal(gw.refunds.length, 1);
  assert.equal((await row("SELECT status FROM appointment_payments WHERE id = (SELECT id FROM appointment_payments LIMIT 1)")).status, "refunded");
  assert.equal((await app.call("GET", `/receipts/${appt.id}`, { as: w.patient })).json.payment.status, "REFUNDED");
  // slot is free again
  assert.equal((await book(w.patient2)).status, 201);
});

test("cancelling inside the no-refund window keeps the payment", async () => {
  const { appt, order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id, "pay_n");
  await pool.query("UPDATE appointments SET appointment_date = CURRENT_DATE + 1, slot_start = '00:05' WHERE id = $1", [appt.id]);
  const c = await app.call("POST", `/appointment/${appt.id}/cancel`, { as: w.patient });
  assert.equal(c.json.refund.status, "not_eligible");
  assert.equal(gw.refunds.length, 0);
  assert.equal((await row("SELECT status FROM appointment_payments LIMIT 1")).status, "paid");
});

test("staff refunds: partial then remainder, over-refund refused, scoped to hospital", async () => {
  const { order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id, "pay_s");
  const pid = (await row("SELECT id FROM appointment_payments LIMIT 1")).id;
  assert.equal((await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.hospAdminB, body: {} })).status, 404);
  assert.equal((await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.recepA, body: {} })).status, 403);
  assert.equal((await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.patient, body: {} })).status, 403);
  const part = await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.hospAdminA, body: { amount: 200, reason: "goodwill" } });
  assert.equal(part.status, 200);
  assert.equal((await row("SELECT status FROM appointment_payments WHERE id = $1", [pid])).status, "partially_refunded");
  assert.equal((await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.admin, body: { amount: 400 } })).status, 400);
  assert.equal((await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.admin, body: { amount: -5 } })).status, 400);
  assert.equal((await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.admin, body: {} })).status, 200);
  assert.equal((await row("SELECT status FROM appointment_payments WHERE id = $1", [pid])).status, "refunded");
  assert.equal((await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.admin, body: {} })).status, 409, "nothing left to refund");
  assert.deepEqual(gw.refunds.map((r) => r.amountPaise), [20000, 30000]);
  assert.ok((await row("SELECT COUNT(*)::int n FROM audit_logs WHERE action = 'payment.refund_requested'")).n >= 2);
});

test("gateway refund failure is recorded, payment stays paid, and can be retried", async () => {
  const { order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id, "pay_g");
  const pid = (await row("SELECT id FROM appointment_payments LIMIT 1")).id;
  gw.refundFails = true;
  const bad = await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.admin, body: {} });
  assert.equal(bad.status, 502);
  assert.equal(bad.json.status, "failed");
  assert.equal((await row("SELECT status FROM appointment_payments WHERE id = $1", [pid])).status, "paid");
  gw.refundFails = false;
  assert.equal((await app.call("POST", `/admin/payments/${pid}/refund`, { as: w.admin, body: {} })).status, 200);
  assert.equal((await row("SELECT status FROM appointment_payments WHERE id = $1", [pid])).status, "refunded");
});

test("refund.processed webhook completes a pending refund", async () => {
  const { order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id, "pay_p");
  const pid = (await row("SELECT id FROM appointment_payments LIMIT 1")).id;
  const { rows } = await pool.query(
    "INSERT INTO refunds (payment_id, amount, status, gateway_refund_id) VALUES ($1, 500, 'pending', 'rfnd_pending') RETURNING id", [pid]);
  const ev = { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_pending" } } } };
  assert.equal((await webhook(ev, "evt_refund")).status, 200);
  assert.equal((await row("SELECT status FROM refunds WHERE id = $1", [rows[0].id])).status, "processed");
  assert.equal((await row("SELECT status FROM appointment_payments WHERE id = $1", [pid])).status, "refunded");
});

// ---- admin visibility ------------------------------------------------------------------------
test("staff payment list is hospital-scoped and filterable", async () => {
  const { order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id, "pay_l");
  await pool.query("UPDATE doctors SET consultation_fee = 300 WHERE id = $1", [w.dB1]);
  const b2 = (await book(w.patient2, { doctor_id: w.dB1, hospital_id: w.hB })).json;
  await order(w.patient2, b2.id);
  const all = await app.call("GET", "/admin/payments", { as: w.admin });
  assert.equal(all.json.total, 2);
  assert.equal((await app.call("GET", "/admin/payments", { as: w.hospAdminA })).json.total, 1);
  assert.equal((await app.call("GET", "/admin/payments?status=paid", { as: w.admin })).json.total, 1);
  assert.equal((await app.call("GET", "/admin/payments", { as: w.docUserA1 })).status, 403);
});

test("database prevents a second successful payment for one appointment", async () => {
  const { appt, order: o } = await heldAndOrdered();
  await verify(w.patient, o.order_id, "pay_1x");
  await assert.rejects(
    pool.query(`INSERT INTO appointment_payments (appointment_id, amount, gateway_order_id, status, gateway_payment_id)
                VALUES ($1, 500, 'order_dup', 'paid', 'pay_dup')`, [appt.id]),
    /uq_appt_payments_one_paid|duplicate key/
  );
});
