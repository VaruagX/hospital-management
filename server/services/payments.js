// Payment lifecycle. A payment becomes "paid" ONLY inside confirmPayment(), which is reachable only after
// the gateway signature (checkout) or webhook signature has been verified by the caller.
const pool = require("../config/db");
const gateway = require("./razorpay");
const { audit } = require("./audit");
const { fail, hospitalNow, releaseExpiredHolds, takenSlots } = require("./booking");
const { timeToMinutes } = require("../utils/slots");

const REFUND_FULL_HOURS = Number(process.env.REFUND_FULL_HOURS ?? 24);

const paise = (amount) => Math.round(Number(amount) * 100);

async function lockSlot(db, doctorId, date) {
  // Same lock key format as the booking transaction, so confirm/reinstate and new bookings serialise.
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${doctorId}:${date}`]);
}

/** Create (or reuse) the gateway order for a held appointment. */
async function createOrderForAppointment(user, appointmentId) {
  if (!gateway.isConfigured()) throw fail(503, "Online payment is not configured yet");
  await releaseExpiredHolds(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const appt = (
      await client.query(
        `SELECT id, user_id, patient_id, status, fee_amount, hold_expires_at,
                (hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()) AS hold_expired
         FROM appointments WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [appointmentId, user.id]
      )
    ).rows[0];
    if (!appt) throw fail(404, "Appointment not found");
    if (appt.status !== "pending_payment") {
      throw fail(409, appt.status === "cancelled"
        ? "This booking has expired or was cancelled. Please book again."
        : "This appointment does not need payment");
    }
    if (appt.hold_expired) throw fail(410, "Your slot hold has expired. Please book again.");
    if (!(Number(appt.fee_amount) > 0)) throw fail(409, "No fee is due for this appointment");

    let payment = (
      await client.query(
        "SELECT * FROM appointment_payments WHERE appointment_id = $1 AND status = 'created' ORDER BY id DESC LIMIT 1",
        [appt.id]
      )
    ).rows[0];
    if (!payment) {
      const order = await gateway.createOrder({
        amountPaise: paise(appt.fee_amount),
        receipt: `APT-${appt.id}-${Date.now().toString(36)}`.slice(0, 40),
        notes: { appointment_id: String(appt.id) },
      });
      payment = (
        await client.query(
          `INSERT INTO appointment_payments (appointment_id, patient_id, amount, currency, gateway_order_id)
           VALUES ($1,$2,$3,'INR',$4) RETURNING *`,
          [appt.id, appt.patient_id, appt.fee_amount, order.id]
        )
      ).rows[0];
    }
    await client.query("COMMIT");
    return { payment, hold_expires_at: appt.hold_expires_at };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Mark a payment paid and confirm its appointment. Idempotent (webhook + checkout verify may both call).
 * Returns { outcome, payment, appointmentId } where outcome is one of
 *   confirmed | already_paid | reinstated | refund_required (money taken but the slot could not be kept).
 */
async function confirmPayment(gatewayOrderId, gatewayPaymentId, { method = null, actor = null } = {}) {
  const client = await pool.connect();
  let result;
  try {
    await client.query("BEGIN");
    const payment = (
      await client.query("SELECT * FROM appointment_payments WHERE gateway_order_id = $1 FOR UPDATE", [gatewayOrderId])
    ).rows[0];
    if (!payment) throw fail(404, "Unknown payment order");
    if (["paid", "refunded", "partially_refunded"].includes(payment.status)) {
      await client.query("COMMIT");
      return { outcome: "already_paid", payment, appointmentId: payment.appointment_id };
    }

    const appt = (
      await client.query(
        `SELECT *, TO_CHAR(appointment_date,'YYYY-MM-DD') AS date_text FROM appointments WHERE id = $1 FOR UPDATE`,
        [payment.appointment_id]
      )
    ).rows[0];
    await lockSlot(client, appt.doctor_id, appt.date_text);

    let outcome;
    if (appt.status === "pending_payment") {
      outcome = "confirmed"; // paid money always wins over a hold that merely timed out unnoticed
    } else if (appt.status === "cancelled" && appt.cancel_reason === "hold_expired") {
      const taken = await takenSlots(client, appt.doctor_id, appt.date_text, appt.id);
      const stale = appt.date_text < hospitalNow().date;
      outcome = !stale && !taken.has(Number(appt.slot_number)) ? "reinstated" : "refund_required";
    } else {
      outcome = "refund_required";
    }

    const paid = (
      await client.query(
        `UPDATE appointment_payments
         SET status = 'paid', gateway_payment_id = $2, method = COALESCE($3, method),
             verified_at = NOW(), paid_at = NOW(), failure_reason = NULL
         WHERE id = $1 RETURNING *`,
        [payment.id, gatewayPaymentId, method]
      )
    ).rows[0];

    if (outcome !== "refund_required") {
      await client.query(
        `UPDATE appointments SET status = 'booked', hold_expires_at = NULL, cancel_reason = NULL, cancelled_at = NULL
         WHERE id = $1`,
        [appt.id]
      );
      await client.query(
        "INSERT INTO receipts (appointment_id, payment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [appt.id, payment.id]
      );
      await client.query(
        `INSERT INTO notifications (user_id, appointment_id, type, title, message)
         VALUES ($1, $2, 'booking_created', 'Booking confirmed', $3)`,
        [appt.user_id, appt.id, `Payment received. Your appointment on ${appt.date_text} is confirmed.`]
      );
    }
    await audit(actor || { id: appt.user_id }, `payment.${outcome}`, "payment", payment.id,
      { appointmentId: appt.id }, { db: client, strict: true });
    await client.query("COMMIT");
    result = { outcome, payment: paid, appointmentId: appt.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (result.outcome === "refund_required") {
    // Taken money must never be kept for a slot we cannot honour.
    await refundPayment(result.payment.id, { reason: "slot_unavailable_after_payment" }).catch((e) =>
      console.error("Automatic refund failed; admin action needed for payment", result.payment.id, e.message)
    );
  }
  return result;
}

async function recordFailure(gatewayOrderId, reason) {
  await pool.query(
    `UPDATE appointment_payments SET attempts = attempts + 1, failure_reason = $2
     WHERE gateway_order_id = $1 AND status = 'created'`,
    [gatewayOrderId, String(reason || "payment failed").slice(0, 300)]
  );
}

/** Refund up to the remaining paid amount. Pending refund row is committed before the gateway is called. */
async function refundPayment(paymentId, { amount = null, reason = null, actor = null } = {}) {
  const client = await pool.connect();
  let payment;
  let refund;
  try {
    await client.query("BEGIN");
    payment = (
      await client.query("SELECT * FROM appointment_payments WHERE id = $1 FOR UPDATE", [paymentId])
    ).rows[0];
    if (!payment) throw fail(404, "Payment not found");
    if (!["paid", "partially_refunded"].includes(payment.status) || !payment.gateway_payment_id) {
      throw fail(409, "Only a verified paid payment can be refunded");
    }
    const used = Number(
      (await client.query("SELECT COALESCE(SUM(amount),0) AS s FROM refunds WHERE payment_id = $1 AND status <> 'failed'", [paymentId])).rows[0].s
    );
    const remaining = Math.round((Number(payment.amount) - used) * 100) / 100;
    const wanted = amount == null ? remaining : Math.round(Number(amount) * 100) / 100;
    if (!(wanted > 0) || wanted > remaining) throw fail(400, `Refund must be between 0.01 and ${remaining}`);
    refund = (
      await client.query(
        "INSERT INTO refunds (payment_id, amount, reason, requested_by) VALUES ($1,$2,$3,$4) RETURNING *",
        [paymentId, wanted, reason, actor?.id ?? null]
      )
    ).rows[0];
    await audit(actor, "payment.refund_requested", "payment", paymentId, { refundId: refund.id, amount: wanted, reason },
      { db: client, strict: true });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  try {
    const response = await gateway.refund({
      paymentId: payment.gateway_payment_id,
      amountPaise: paise(refund.amount),
      notes: { refund_id: String(refund.id) },
    });
    const processed = response.status === "processed";
    refund = (
      await pool.query(
        `UPDATE refunds SET gateway_refund_id = $2, status = $3, processed_at = CASE WHEN $3 = 'processed' THEN NOW() END
         WHERE id = $1 RETURNING *`,
        [refund.id, response.id, processed ? "processed" : "pending"]
      )
    ).rows[0];
    if (processed) await syncPaymentRefundStatus(paymentId);
  } catch (error) {
    refund = (
      await pool.query("UPDATE refunds SET status = 'failed', error = $2 WHERE id = $1 RETURNING *", [
        refund.id, String(error.message).slice(0, 300),
      ])
    ).rows[0];
  }
  return refund;
}

async function syncPaymentRefundStatus(paymentId) {
  await pool.query(
    `UPDATE appointment_payments p
     SET status = CASE WHEN r.total >= p.amount THEN 'refunded' ELSE 'partially_refunded' END
     FROM (SELECT COALESCE(SUM(amount),0) AS total FROM refunds WHERE payment_id = $1 AND status = 'processed') r
     WHERE p.id = $1 AND r.total > 0`,
    [paymentId]
  );
}

async function markRefundProcessed(gatewayRefundId) {
  const refund = (
    await pool.query(
      `UPDATE refunds SET status = 'processed', processed_at = COALESCE(processed_at, NOW())
       WHERE gateway_refund_id = $1 RETURNING payment_id`,
      [gatewayRefundId]
    )
  ).rows[0];
  if (refund) await syncPaymentRefundStatus(refund.payment_id);
}

/** Cancellation policy: full refund when cancelled at least REFUND_FULL_HOURS before the slot, otherwise none. */
function isRefundEligible(dateText, slotStart, now = hospitalNow()) {
  const [y, m, d] = dateText.split("-").map(Number);
  const nowDay = now.date.split("-").map(Number);
  const dayDiff = (Date.UTC(y, m - 1, d) - Date.UTC(nowDay[0], nowDay[1] - 1, nowDay[2])) / 86400000;
  const minutesUntil = dayDiff * 1440 + timeToMinutes(slotStart || "00:00") - now.minutes;
  return minutesUntil >= REFUND_FULL_HOURS * 60;
}

module.exports = {
  REFUND_FULL_HOURS, confirmPayment, createOrderForAppointment, isRefundEligible,
  markRefundProcessed, recordFailure, refundPayment,
};
