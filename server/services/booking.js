// Booking rules shared by the booking, slot-listing and payment code.
const { buildDoctorSlots, timeToMinutes } = require("../utils/slots");

const HOSPITAL_TZ = process.env.HOSPITAL_TZ || "Asia/Kolkata";
const HOLD_MINUTES = Math.max(Number(process.env.SLOT_HOLD_MINUTES) || 15, 1);
const MAX_ADVANCE_DAYS = Math.max(Number(process.env.MAX_ADVANCE_BOOKING_DAYS) || 90, 1);

function fail(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

/** Current date (YYYY-MM-DD) and minutes-since-midnight in the hospital's timezone. */
function hospitalNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: HOSPITAL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function assertBookableDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) {
    throw fail(400, "Date must be a valid YYYY-MM-DD date");
  }
  const today = hospitalNow().date;
  if (date < today) throw fail(400, "Appointments cannot be booked in the past");
  const limit = new Date(Date.parse(`${today}T12:00:00Z`) + MAX_ADVANCE_DAYS * 86400000).toISOString().slice(0, 10);
  if (date > limit) throw fail(400, `Appointments can be booked at most ${MAX_ADVANCE_DAYS} days ahead`);
}

/** Why a slot cannot be booked on `date`, or "" if the time itself is fine. Booked-state is checked separately. */
function slotTimeProblem(doctor, slot, date) {
  const now = hospitalNow();
  if (date === now.date && timeToMinutes(slot.startTime) <= now.minutes) return "This time has already passed";
  const opens = doctor.opens_at ? timeToMinutes(doctor.opens_at) : null;
  const closes = doctor.closes_at ? timeToMinutes(doctor.closes_at) : null;
  if (opens != null && timeToMinutes(slot.startTime) < opens) return "Outside hospital operating hours";
  if (closes != null && timeToMinutes(slot.endTime) > closes) return "Outside hospital operating hours";
  return "";
}

function doctorSlots(doctor) {
  return buildDoctorSlots({
    availableFrom: doctor.available_from,
    availableTo: doctor.available_to,
    slotStepMinutes: doctor.slot_step_minutes,
    slotDurationMinutes: doctor.slot_duration_minutes,
  });
}

/** Slot numbers currently taken (booked or held) for doctor/date. */
async function takenSlots(db, doctorId, date, excludeAppointmentId = null) {
  const { rows } = await db.query(
    `SELECT slot_number FROM appointments
     WHERE doctor_id = $1 AND appointment_date = $2 AND status IS DISTINCT FROM 'cancelled'
       AND slot_number IS NOT NULL AND ($3::int IS NULL OR id <> $3)`,
    [doctorId, date, excludeAppointmentId]
  );
  return new Set(rows.map((r) => Number(r.slot_number)));
}

/**
 * Pick the slot to book. With `requested` the patient's exact choice must be valid and free;
 * without it the earliest free, bookable slot is used. Caller must hold the doctor/date advisory lock.
 */
async function chooseSlot(db, doctor, date, requested, excludeAppointmentId = null) {
  const slots = doctorSlots(doctor);
  const taken = await takenSlots(db, doctor.id, date, excludeAppointmentId);
  if (requested != null && requested !== "") {
    const slot = slots.find((s) => s.slotNumber === Number(requested));
    if (!slot) throw fail(400, "That time slot does not exist for this doctor");
    if (taken.has(slot.slotNumber)) throw fail(409, "That time slot has just been taken. Please choose another.");
    const problem = slotTimeProblem(doctor, slot, date);
    if (problem) throw fail(400, problem);
    return slot;
  }
  const slot = slots.find((s) => !taken.has(s.slotNumber) && !slotTimeProblem(doctor, s, date));
  if (!slot) throw fail(409, "No free slots are left for this doctor on the selected date.");
  return slot;
}

/**
 * Release unpaid holds whose time ran out. Released rows become 'cancelled' (reason hold_expired), which
 * every existing query already treats as "slot free". Safe to call concurrently (row-level UPDATE).
 */
async function releaseExpiredHolds(db) {
  const { rows } = await db.query(
    `UPDATE appointments
     SET status = 'cancelled', cancel_reason = 'hold_expired', cancelled_at = NOW(), hold_expires_at = NULL
     WHERE status = 'pending_payment' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
     RETURNING id`
  );
  return rows.map((r) => r.id);
}

module.exports = {
  HOLD_MINUTES, HOSPITAL_TZ, MAX_ADVANCE_DAYS,
  assertBookableDate, chooseSlot, doctorSlots, fail, hospitalNow,
  releaseExpiredHolds, slotTimeProblem, takenSlots,
};
