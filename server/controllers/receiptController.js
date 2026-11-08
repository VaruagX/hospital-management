// Digital receipts. A receipt exists only for an appointment with a VERIFIED paid payment (see payments.confirmPayment).
const PDFDocument = require("pdfkit");
const pool = require("../config/db");
const { audit } = require("../services/audit");
const { canAccessAppointment } = require("../policies/access");
const { roleOf } = require("../middleware/auth");
const { parseId } = require("../utils/validate");

async function loadReceipt(req) {
  const appointmentId = parseId(req.params.appointmentId);
  if (!appointmentId) return null;
  const row = (
    await pool.query(
      `SELECT r.receipt_no, r.issued_at,
              a.id AS appointment_id, a.user_id, a.doctor_id, a.hospital_id, a.token_number, a.created_at AS booked_at,
              TO_CHAR(a.appointment_date,'YYYY-MM-DD') AS appointment_date,
              TO_CHAR(a.slot_start,'HH24:MI') AS slot_start, TO_CHAR(a.slot_end,'HH24:MI') AS slot_end,
              a.reason_for_visit, a.user_name,
              pt.full_name AS patient_name, pt.mrn, pt.phone AS patient_phone,
              d.name AS doctor_name, d.specialization, d.qualification,
              h.name AS hospital_name, h.address AS hospital_address, h.location AS hospital_location,
              h.contact_phone AS hospital_phone, h.email AS hospital_email, h.logo AS hospital_logo,
              c.name AS city_name,
              pay.amount, pay.currency, pay.method, pay.status AS payment_status,
              pay.gateway_payment_id, pay.gateway_order_id, pay.paid_at
       FROM receipts r
       JOIN appointments a ON a.id = r.appointment_id
       JOIN appointment_payments pay ON pay.id = r.payment_id AND pay.verified_at IS NOT NULL
       JOIN doctors d ON d.id = a.doctor_id
       JOIN hospitals h ON h.id = a.hospital_id
       JOIN cities c ON c.id = h.city_id
       LEFT JOIN patients pt ON pt.id = a.patient_id
       WHERE a.id = $1`,
      [appointmentId]
    )
  ).rows[0];
  if (!row) return null;
  const isOwner = row.user_id === req.user.id;
  const isStaff = roleOf(req.user) !== "patient" && canAccessAppointment(req.user, row);
  return isOwner || isStaff ? row : null; // 404 either way: do not reveal other people's receipts
}

const STATUS_LABEL = { paid: "PAID", refunded: "REFUNDED", partially_refunded: "PARTIALLY REFUNDED" };

function viewModel(r) {
  return {
    receipt_no: r.receipt_no,
    appointment_id: r.appointment_id,
    appointment_ref: `APT-${String(r.appointment_id).padStart(6, "0")}`,
    issued_at: r.issued_at,
    booked_at: r.booked_at,
    hospital: { name: r.hospital_name, address: r.hospital_address || r.hospital_location, phone: r.hospital_phone, email: r.hospital_email, city: r.city_name, logo: r.hospital_logo },
    doctor: { name: r.doctor_name, specialization: r.specialization, qualification: r.qualification },
    patient: { name: r.patient_name || r.user_name, mrn: r.mrn, phone: r.patient_phone },
    appointment: { date: r.appointment_date, start: r.slot_start, end: r.slot_end, time: to12h(r.slot_start), token_number: r.token_number, reason: r.reason_for_visit },
    payment: {
      amount: Number(r.amount), currency: r.currency, method: r.method || "online",
      status: STATUS_LABEL[r.payment_status] || r.payment_status.toUpperCase(),
      transaction_id: r.gateway_payment_id, order_id: r.gateway_order_id, paid_at: r.paid_at,
    },
  };
}

function to12h(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function longDate(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v, cur) => `${cur === "INR" ? "₹" : cur + " "}${v.toFixed(2)}`;

async function getReceipt(req, res, next) {
  try {
    const r = await loadReceipt(req);
    if (!r) return res.status(404).json({ error: "Receipt not found" });
    return res.json(viewModel(r));
  } catch (error) {
    return next(error);
  }
}

async function printReceipt(req, res, next) {
  try {
    const r = await loadReceipt(req);
    if (!r) return res.status(404).type("text").send("Receipt not found");
    const m = viewModel(r);
    res.set({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    });
    const logo = /^\/media\/\d+$/.test(m.hospital.logo || "") ? `<img src="${esc(m.hospital.logo)}" alt="" style="height:48px">` : "";
    return res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${esc(m.receipt_no)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;color:#14202b;margin:0;background:#f4f6f8}
.sheet{max-width:720px;margin:24px auto;background:#fff;padding:32px;border:1px solid #dde3ea;border-radius:12px}
header{display:flex;gap:16px;align-items:center;border-bottom:2px solid #0e7490;padding-bottom:16px}
h1{font-size:20px;margin:0}h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5b6b7a;margin:24px 0 8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px}.k{color:#5b6b7a}.badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#e6f6ee;color:#12703f;font-weight:600}
.total{font-size:22px;font-weight:700}button{margin-top:24px;padding:10px 18px;border:0;border-radius:8px;background:#0e7490;color:#fff;font-size:15px;cursor:pointer}
@media print{body{background:#fff}.sheet{border:0;margin:0}button{display:none}}@media(max-width:560px){.grid{grid-template-columns:1fr}}</style></head><body>
<div class="sheet"><header>${logo}<div><h1>${esc(m.hospital.name)}</h1><div class="k">${esc(m.hospital.address)}${m.hospital.city ? ", " + esc(m.hospital.city) : ""}<br>${esc(m.hospital.phone || "")} ${esc(m.hospital.email || "")}</div></div></header>
<h2>Appointment receipt</h2><div class="grid"><div><span class="k">Receipt no.</span><br><b>${esc(m.receipt_no)}</b></div><div><span class="k">Appointment ID</span><br><b>${esc(m.appointment_ref)}</b></div>
<div><span class="k">Booked on</span><br>${esc(longDate(new Date(m.booked_at).toISOString().slice(0, 10)))}</div><div><span class="k">Payment status</span><br><span class="badge">${esc(m.payment.status)}</span></div></div>
<h2>Patient</h2><div class="grid"><div><span class="k">Name</span><br>${esc(m.patient.name)}</div><div><span class="k">Patient ID (MRN)</span><br>${esc(m.patient.mrn || "—")}</div></div>
<h2>Consultation</h2><div class="grid"><div><span class="k">Doctor</span><br>${esc(m.doctor.name)}<br><span class="k">${esc(m.doctor.specialization || "")}</span></div>
<div><span class="k">Date &amp; time</span><br><b>${esc(longDate(m.appointment.date))}, ${esc(m.appointment.time)}</b></div><div><span class="k">Token number</span><br>${esc(m.appointment.token_number)}</div></div>
<h2>Payment</h2><div class="grid"><div><span class="k">Consultation fee</span><br><span class="total">${esc(money(m.payment.amount, m.payment.currency))}</span></div>
<div><span class="k">Method</span><br>${esc(m.payment.method)}</div><div style="grid-column:1/-1"><span class="k">Transaction ID</span><br>${esc(m.payment.transaction_id)}</div></div>
<button onclick="window.print()">Print receipt</button></div></body></html>`);
  } catch (error) {
    return next(error);
  }
}

async function pdfReceipt(req, res, next) {
  try {
    const r = await loadReceipt(req);
    if (!r) return res.status(404).json({ error: "Receipt not found" });
    const m = viewModel(r);
    await audit(req, "receipt.download", "appointment", m.appointment_id, { receipt: m.receipt_no });

    let logoBuffer = null;
    const mediaId = /^\/media\/(\d+)$/.exec(m.hospital.logo || "");
    if (mediaId) {
      const media = (await pool.query("SELECT content, mime_type FROM media WHERE id = $1", [Number(mediaId[1])])).rows[0];
      if (media && media.mime_type !== "image/webp") logoBuffer = media.content; // pdfkit reads png/jpeg only
    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${m.receipt_no}.pdf"`,
      "Cache-Control": "private, no-store",
    });
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Receipt ${m.receipt_no}`, Author: m.hospital.name } });
    doc.pipe(res);
    const ink = "#14202b", muted = "#5b6b7a", accent = "#0e7490";

    let x = 50;
    if (logoBuffer) {
      try { doc.image(logoBuffer, 50, 45, { fit: [48, 48] }); x = 108; } catch { /* unreadable image: skip logo */ }
    }
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(18).text(m.hospital.name, x, 48);
    doc.font("Helvetica").fontSize(10).fillColor(muted)
      .text([m.hospital.address, m.hospital.city].filter(Boolean).join(", "), x)
      .text([m.hospital.phone, m.hospital.email].filter(Boolean).join("  |  "), x);
    doc.moveTo(50, 105).lineTo(545, 105).lineWidth(2).strokeColor(accent).stroke();

    doc.y = 120;
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(13).text("APPOINTMENT RECEIPT", 50);
    const row = (label, value, bold = false) => {
      const y = doc.y + 6;
      doc.font("Helvetica").fontSize(10).fillColor(muted).text(label, 50, y, { width: 170 });
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor(ink).text(String(value ?? "—"), 225, y, { width: 320 });
      doc.y = Math.max(doc.y, y + 14);
    };
    const section = (title) => { doc.moveDown(0.8); doc.font("Helvetica-Bold").fontSize(9).fillColor(muted).text(title.toUpperCase(), 50); };

    section("Reference");
    row("Receipt number", m.receipt_no, true);
    row("Appointment ID", m.appointment_ref, true);
    row("Booking date", longDate(new Date(m.booked_at).toISOString().slice(0, 10)));
    section("Patient");
    row("Patient name", m.patient.name, true);
    row("Patient ID (MRN)", m.patient.mrn);
    section("Consultation");
    row("Doctor", m.doctor.name, true);
    row("Specialization", [m.doctor.specialization, m.doctor.qualification].filter(Boolean).join(" — "));
    row("Appointment date", longDate(m.appointment.date), true);
    row("Appointment time", `${m.appointment.time}${m.appointment.end ? " – " + to12h(m.appointment.end) : ""}`, true);
    row("Token number", m.appointment.token_number);
    section("Payment");
    row("Consultation fee", `${m.payment.currency} ${m.payment.amount.toFixed(2)}`, true);
    row("Payment method", m.payment.method);
    row("Transaction ID", m.payment.transaction_id);
    row("Payment status", m.payment.status, true);
    doc.moveDown(2).font("Helvetica").fontSize(8).fillColor(muted)
      .text("This is a computer-generated receipt issued after verified payment and needs no signature.", 50, doc.y, { width: 495 });
    doc.end();
  } catch (error) {
    if (res.headersSent) return res.end();
    return next(error);
  }
}

module.exports = { getReceipt, pdfReceipt, printReceipt };
