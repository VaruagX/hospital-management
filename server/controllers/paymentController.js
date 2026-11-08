const pool = require("../config/db");
const gateway = require("../services/razorpay");
const payments = require("../services/payments");
const { audit } = require("../services/audit");
const { scopeOf } = require("../policies/access");
const { parseId } = require("../utils/validate");

/** Step 1: create (or reuse) the gateway order for a held appointment. Amount comes from the DB, never the client. */
async function createOrder(req, res, next) {
  try {
    const appointmentId = parseId(req.body.appointment_id);
    if (!appointmentId) return res.status(400).json({ error: "appointment_id is required" });
    const { payment, hold_expires_at: holdExpiresAt } = await payments.createOrderForAppointment(req.user, appointmentId);
    return res.status(201).json({
      key_id: gateway.publicKeyId(), // public by design; the key SECRET never leaves the server
      order_id: payment.gateway_order_id,
      amount: Number(payment.amount),
      amount_paise: Math.round(Number(payment.amount) * 100),
      currency: payment.currency,
      appointment_id: payment.appointment_id,
      hold_expires_at: holdExpiresAt,
    });
  } catch (error) {
    return next(error);
  }
}

/** Step 2: browser reports success. Nothing is trusted until the HMAC signature verifies. */
async function verifyPayment(req, res, next) {
  try {
    const orderId = String(req.body.razorpay_order_id || "");
    const paymentId = String(req.body.razorpay_payment_id || "");
    const signature = String(req.body.razorpay_signature || "");

    const own = (
      await pool.query(
        `SELECT p.id FROM appointment_payments p JOIN appointments a ON a.id = p.appointment_id
         WHERE p.gateway_order_id = $1 AND a.user_id = $2`,
        [orderId, req.user.id]
      )
    ).rows[0];
    if (!own) return res.status(404).json({ error: "Payment order not found" });

    if (!gateway.verifyCheckoutSignature(orderId, paymentId, signature)) {
      await audit(req, "payment.verify_failed", "payment", own.id, { orderId });
      return res.status(400).json({ error: "Payment could not be verified" });
    }
    const result = await payments.confirmPayment(orderId, paymentId, { actor: req.user });
    if (result.outcome === "refund_required") {
      return res.status(409).json({
        error: "Your payment was received but the slot is no longer available. It is being refunded automatically.",
        outcome: result.outcome,
      });
    }
    return res.json({ status: "paid", outcome: result.outcome, appointment_id: result.appointmentId });
  } catch (error) {
    return next(error);
  }
}

/** Gateway webhook. Signature is verified over the RAW body; each event id is processed once. */
async function webhook(req, res, next) {
  try {
    const signature = req.get("x-razorpay-signature");
    if (!req.rawBody || !gateway.verifyWebhookSignature(req.rawBody, signature)) {
      return res.status(400).json({ error: "Invalid signature" });
    }
    const event = req.body;
    const eventId = req.get("x-razorpay-event-id");
    if (!eventId) return res.status(400).json({ error: "Missing event id" });

    const fresh = await pool.query(
      "INSERT INTO payment_events (event_id, event_type) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id",
      [eventId, String(event.event || "").slice(0, 80)]
    );
    if (!fresh.rowCount) return res.json({ status: "duplicate_ignored" });

    try {
      const paymentEntity = event.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      switch (event.event) {
        case "payment.captured":
        case "order.paid":
          if (orderId && paymentEntity?.id) {
            await payments.confirmPayment(orderId, paymentEntity.id, { method: paymentEntity.method || null });
          }
          break;
        case "payment.failed":
          if (orderId) await payments.recordFailure(orderId, paymentEntity?.error_description || paymentEntity?.error_code);
          break;
        case "refund.processed":
          if (event.payload?.refund?.entity?.id) await payments.markRefundProcessed(event.payload.refund.entity.id);
          break;
        default:
          break;
      }
    } catch (error) {
      // Let the gateway retry: forget the event so the retry is processed.
      await pool.query("DELETE FROM payment_events WHERE event_id = $1", [eventId]);
      throw error;
    }
    return res.json({ status: "ok" });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------- patient + staff views
async function myPayments(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.amount, p.currency, p.status, p.method, p.paid_at, p.created_at, p.appointment_id,
              r.receipt_no, d.name AS doctor_name, h.name AS hospital_name,
              TO_CHAR(a.appointment_date,'YYYY-MM-DD') AS appointment_date
       FROM appointment_payments p
       JOIN appointments a ON a.id = p.appointment_id
       JOIN doctors d ON d.id = a.doctor_id JOIN hospitals h ON h.id = a.hospital_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE a.user_id = $1 ORDER BY p.id DESC LIMIT 200`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

async function staffListPayments(req, res, next) {
  try {
    const scope = scopeOf(req.user);
    if (!scope) return res.status(403).json({ error: "Your account is not assigned to a hospital" });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const values = [];
    const clauses = [];
    if (!scope.all) {
      values.push(scope.hospitalId);
      clauses.push(`a.hospital_id = $${values.length}`);
    }
    if (req.query.status) {
      values.push(String(req.query.status));
      clauses.push(`p.status = $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT p.id, p.appointment_id, p.amount, p.status, p.method, p.paid_at, p.gateway_payment_id,
                r.receipt_no, a.user_name AS patient_name, d.name AS doctor_name, h.name AS hospital_name,
                COALESCE((SELECT SUM(amount) FROM refunds f WHERE f.payment_id = p.id AND f.status <> 'failed'),0) AS refunded
         FROM appointment_payments p
         JOIN appointments a ON a.id = p.appointment_id
         JOIN doctors d ON d.id = a.doctor_id JOIN hospitals h ON h.id = a.hospital_id
         LEFT JOIN receipts r ON r.payment_id = p.id
         ${where} ORDER BY p.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        values
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM appointment_payments p JOIN appointments a ON a.id = p.appointment_id ${where}`, values),
    ]);
    return res.json({ page, limit, total: total.rows[0].n, items: rows.rows });
  } catch (error) {
    return next(error);
  }
}

/** Staff refund (full by default). Hospital admins only for their own hospital's payments. */
async function staffRefund(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const scope = scopeOf(req.user);
    const row = id
      ? (await pool.query(
          `SELECT p.id, a.hospital_id FROM appointment_payments p JOIN appointments a ON a.id = p.appointment_id WHERE p.id = $1`, [id])).rows[0]
      : null;
    if (!row || !scope || (!scope.all && scope.hospitalId !== row.hospital_id)) {
      return res.status(404).json({ error: "Payment not found" });
    }
    const refund = await payments.refundPayment(id, {
      amount: req.body.amount ?? null,
      reason: String(req.body.reason || "staff_refund").slice(0, 200),
      actor: req.user,
    });
    return res.status(refund.status === "failed" ? 502 : 200).json(refund);
  } catch (error) {
    return next(error);
  }
}

module.exports = { createOrder, myPayments, staffListPayments, staffRefund, verifyPayment, webhook };
