const pool = require("../config/db");
const gateway = require("../services/razorpay");
const { assertBookableDate, chooseSlot, HOLD_MINUTES, releaseExpiredHolds } = require("../services/booking");
const { resolvePatient } = require("../services/patients");
const { isRefundEligible, refundPayment } = require("../services/payments");
const { audit } = require("../services/audit");
const PRIORITY_RANK_SQL = `CASE WHEN COALESCE(priority, 'normal') = 'emergency' THEN 0 ELSE 1 END`;

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function normalizePriority(priority) {
  return String(priority || "normal").toLowerCase() === "emergency"
    ? "emergency"
    : "normal";
}

function getPriorityRank(priority) {
  return normalizePriority(priority) === "emergency" ? 0 : 1;
}

function formatNotificationDate(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

async function createNotification(client, { userId, appointmentId, type, title, message }) {
  await client.query(
    `INSERT INTO notifications (user_id, appointment_id, type, title, message)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, appointmentId || null, type, title, message]
  );
}

async function createAppointment(req, res, next) {
  const client = await pool.connect();

  try {
    const {
      name,
      mobile,
      date,
      doctor_id: doctorId,
      hospital_id: hospitalId,
      family_member_id: familyMemberId,
      reason_for_visit: reasonForVisit,
      priority,
      slot_number: requestedSlot,
    } = req.body;
    const normalizedPriority = normalizePriority(priority);
    const trimmedReasonForVisit = String(reasonForVisit || "").trim();

    if (!mobile || !date || !doctorId || !hospitalId) {
      return res.status(400).json({ error: "Doctor, hospital, date, and mobile are required" });
    }

    if (!trimmedReasonForVisit) {
      return res.status(400).json({ error: "Reason for visit is required" });
    }

    assertBookableDate(date);

    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${doctorId}:${date}`,
    ]);
    await releaseExpiredHolds(client);

    const doctor = await getDoctorBookingMeta(client, doctorId, hospitalId);
    if (!doctor) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Doctor or hospital not found" });
    }

    // Paid consultations are held (not confirmed) until the gateway verifies payment.
    const fee = Number(doctor.consultation_fee) || 0;
    const needsPayment = fee > 0;
    if (needsPayment && !gateway.isConfigured()) {
      await client.query("ROLLBACK");
      return res.status(503).json({ error: "Online payment is not available right now. Please try again later." });
    }

    const dayBlockMessage = getDoctorBlockedMessage(doctor, date);
    if (dayBlockMessage) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: dayBlockMessage });
    }

    const leaveBlockMessage = await getDoctorLeaveMessage(client, doctorId, date);
    if (leaveBlockMessage) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: leaveBlockMessage });
    }

    const activeAppointments = await getActiveAppointmentCount(client, doctorId, date);
    if (
      doctor.max_patients_per_day &&
      activeAppointments >= Number(doctor.max_patients_per_day)
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `Daily booking limit reached for Dr. ${doctor.name}.`,
      });
    }

    const nextTokenNumber = await getNextTokenNumber(client, doctorId, date);
    const selectedSlot = await chooseSlot(client, doctor, date, requestedSlot);

    const familyMember = familyMemberId
      ? await getFamilyMember(client, familyMemberId, req.user.id)
      : null;
    if (familyMemberId && !familyMember) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Family member not found" });
    }

    const ownedPatient = req.body.patient_id
      ? (
          await client.query(
            "SELECT id, full_name, phone FROM patients WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            [Number(req.body.patient_id) || 0, req.user.id]
          )
        ).rows[0]
      : null;
    if (req.body.patient_id && !ownedPatient) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Patient record not found" });
    }

    const bookingName = familyMember?.name || ownedPatient?.full_name || name;
    if (!bookingName || !String(bookingName).trim()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Patient name is required" });
    }

    const patientId = ownedPatient
      ? ownedPatient.id
      : await resolveBookingPatient(client, req, { name: bookingName.trim(), mobile, familyMember });

    const patientsBeforeResult = await client.query(
      `SELECT COUNT(*)::int AS patients_before
       FROM appointments
       WHERE doctor_id = $1
         AND appointment_date = $2
         AND COALESCE(status, 'booked') <> 'cancelled'
         AND (
           ${PRIORITY_RANK_SQL} < $3
           OR (${PRIORITY_RANK_SQL} = $3 AND COALESCE(token_number, 0) < $4)
         )`,
      [doctorId, date, getPriorityRank(normalizedPriority), nextTokenNumber]
    );

    const appointmentResult = await client.query(
      `INSERT INTO appointments (
         user_id,
         user_name,
         mobile,
         doctor_id,
         hospital_id,
         appointment_date,
         token_number,
         slot_number,
         slot_start,
         slot_end,
         family_member_id,
         reason_for_visit,
         priority,
         status,
         patient_id,
         fee_amount,
         hold_expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               CASE WHEN $14 = 'pending_payment' THEN NOW() + make_interval(mins => $17::int) END)
       RETURNING id,
                 TO_CHAR(appointment_date, 'YYYY-MM-DD') AS appointment_date,
                 token_number,
                 slot_number,
                 TO_CHAR(slot_start, 'HH24:MI') AS slot_start,
                 TO_CHAR(slot_end, 'HH24:MI') AS slot_end,
                 doctor_id,
                 hospital_id,
                 family_member_id,
                 reason_for_visit,
                 COALESCE(priority, 'normal') AS priority,
                 status,
                 patient_id,
                 fee_amount,
                 hold_expires_at`,
      [
        req.user.id,
        bookingName.trim(),
        mobile,
        doctorId,
        hospitalId,
        date,
        nextTokenNumber,
        selectedSlot.slotNumber,
        selectedSlot.startTime,
        selectedSlot.endTime,
        familyMember?.id || null,
        trimmedReasonForVisit,
        normalizedPriority,
        needsPayment ? "pending_payment" : "booked",
        patientId,
        needsPayment ? fee : null,
        HOLD_MINUTES,
      ]
    );

    await client.query(
      `UPDATE users
       SET phone = $1
       WHERE id = $2`,
      [mobile, req.user.id]
    );

    const appointment = appointmentResult.rows[0];

    if (!needsPayment) {
      await createNotification(client, {
        userId: req.user.id,
        appointmentId: appointment.id,
        type: "booking_created",
        title: "Booking created",
        message: `Appointment with Dr. ${doctor.name} at ${doctor.hospital_name} was booked for ${formatNotificationDate(date)}.`,
      });
    }

    await client.query("COMMIT");

    return res.status(201).json({
      ...appointment,
      doctor_name: doctor.name,
      hospital_name: doctor.hospital_name,
      family_member_name: familyMember?.name || null,
      family_relation: familyMember?.relation || null,
      requires_payment: needsPayment,
      patients_before: patientsBeforeResult.rows[0]?.patients_before || 0,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function cancelAppointment(req, res, next) {
  const client = await pool.connect();

  try {
    const { appointmentId } = req.params;
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE appointments a
       SET status = 'cancelled', cancel_reason = 'patient_cancelled', cancelled_at = NOW(), hold_expires_at = NULL
       FROM doctors d, hospitals h
       WHERE a.id = $1
         AND a.user_id = $2
         AND COALESCE(a.status, 'booked') NOT IN ('completed', 'cancelled')
         AND d.id = a.doctor_id
         AND h.id = a.hospital_id
       RETURNING a.id,
                 d.name AS doctor_name,
                 h.name AS hospital_name,
                 TO_CHAR(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
                 TO_CHAR(a.slot_start, 'HH24:MI') AS slot_start`,
      [appointmentId, req.user.id]
    );

    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Appointment cannot be cancelled" });
    }

    await createNotification(client, {
      userId: req.user.id,
      appointmentId: result.rows[0].id,
      type: "booking_cancelled",
      title: "Appointment cancelled",
      message: `Your appointment with Dr. ${result.rows[0].doctor_name} at ${result.rows[0].hospital_name} on ${formatNotificationDate(result.rows[0].appointment_date)} was cancelled.`,
    });

    await client.query("COMMIT");

    // Refund policy: a verified payment is refunded in full when cancelled early enough.
    const cancelled = result.rows[0];
    const paid = (
      await pool.query(
        "SELECT id FROM appointment_payments WHERE appointment_id = $1 AND status = 'paid'",
        [cancelled.id]
      )
    ).rows[0];
    let refund = null;
    if (paid) {
      if (isRefundEligible(cancelled.appointment_date, cancelled.slot_start)) {
        refund = await refundPayment(paid.id, { reason: "patient_cancelled", actor: req.user });
      } else {
        refund = { status: "not_eligible" };
      }
      await audit(req, "appointment.cancel_paid", "appointment", cancelled.id, { refund: refund.status });
    }
    return res.json({ success: true, refund: refund && { status: refund.status, amount: refund.amount ?? null } });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function rescheduleAppointment(req, res, next) {
  const client = await pool.connect();

  try {
    const { appointmentId } = req.params;
    const { date, slot_number: requestedSlot } = req.body;

    if (!date) {
      return res.status(400).json({ error: "New appointment date is required" });
    }
    assertBookableDate(date);

    await client.query("BEGIN");
    const appointmentLookup = await client.query(
      `SELECT id, doctor_id, hospital_id, user_id, status,
              TO_CHAR(appointment_date, 'YYYY-MM-DD') AS previous_date
       FROM appointments
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [appointmentId, req.user.id]
    );

    const appointment = appointmentLookup.rows[0];
    if (!appointment || ["completed", "cancelled", "pending_payment"].includes((appointment.status || "").toLowerCase())) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Appointment cannot be rescheduled" });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${appointment.doctor_id}:${date}`,
    ]);

    const doctor = await getDoctorBookingMeta(client, appointment.doctor_id, appointment.hospital_id);
    if (!doctor) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Doctor or hospital not found" });
    }
    const dayBlockMessage = getDoctorBlockedMessage(doctor, date);
    if (dayBlockMessage) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: dayBlockMessage });
    }

    const leaveBlockMessage = await getDoctorLeaveMessage(client, appointment.doctor_id, date);
    if (leaveBlockMessage) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: leaveBlockMessage });
    }

    const activeAppointments = await getActiveAppointmentCount(
      client,
      appointment.doctor_id,
      date,
      appointment.id
    );
    if (
      doctor.max_patients_per_day &&
      activeAppointments >= Number(doctor.max_patients_per_day)
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `Daily booking limit reached for Dr. ${doctor.name}.`,
      });
    }

    const nextTokenNumber = await getNextTokenNumber(
      client,
      appointment.doctor_id,
      date,
      appointment.id
    );
    const selectedSlot = await chooseSlot(client, doctor, date, requestedSlot, appointment.id);

    const updated = await client.query(
      `UPDATE appointments
       SET appointment_date = $1,
           token_number = $2,
           slot_number = $6,
           slot_start = $3,
           slot_end = $4,
           checked_in_at = NULL,
           reminder_sent_at = NULL,
           status = 'booked'
       WHERE id = $5
       RETURNING id`,
      [
        date,
        nextTokenNumber,
        selectedSlot.startTime,
        selectedSlot.endTime,
        appointment.id,
        selectedSlot.slotNumber,
      ]
    );

    await createNotification(client, {
      userId: req.user.id,
      appointmentId: updated.rows[0].id,
      type: "booking_rescheduled",
      title: "Appointment rescheduled",
      message: `Your appointment with Dr. ${doctor.name} at ${doctor.hospital_name} moved from ${formatNotificationDate(appointment.previous_date)} to ${formatNotificationDate(date)}.`,
    });

    await client.query("COMMIT");
    return res.json({ success: true, appointmentId: updated.rows[0].id });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function checkInAppointment(req, res, next) {
  try {
    const { appointmentId } = req.params;
    const lookup = await pool.query(
      `SELECT id, status, (appointment_date = CURRENT_DATE) AS is_today
       FROM appointments
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [appointmentId, req.user.id]
    );

    const appointment = lookup.rows[0];
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    if (!appointment.is_today) {
      return res.status(400).json({ error: "Digital check-in opens on the appointment day." });
    }

    const normalizedStatus = (appointment.status || "booked").toLowerCase();
    if (normalizedStatus === "checked_in") {
      return res.json({ id: appointment.id, status: "checked_in" });
    }

    if (!["booked", "pending"].includes(normalizedStatus)) {
      return res.status(400).json({ error: "This appointment cannot be checked in." });
    }

    const result = await pool.query(
      `UPDATE appointments
       SET status = 'checked_in',
           checked_in_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, status`,
      [appointmentId, req.user.id]
    );

    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getDoctorBookingMeta(client, doctorId, hospitalId) {
  const result = await client.query(
    `SELECT d.id,
            d.name,
            d.specialization,
            d.department_id,
            d.max_patients_per_day,
            d.consultation_fee,
            h.opens_at,
            h.closes_at,
            d.available_from,
            d.available_to,
            d.slot_step_minutes,
            d.slot_duration_minutes,
            d.unavailable_days,
            d.availability_note,
            h.id AS hospital_id,
            h.name AS hospital_name
     FROM doctors d
     JOIN hospitals h ON h.id = d.hospital_id
     JOIN cities c ON c.id = h.city_id AND c.is_active
     WHERE d.id = $1 AND h.id = $2 AND d.is_active AND h.is_active`,
    [doctorId, hospitalId]
  );

  return result.rows[0] || null;
}

function getDoctorBlockedMessage(doctor, date) {
  const bookingDay = DAY_NAMES[getDateDayIndex(date)];
  const blockedDays = String(doctor?.unavailable_days || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!blockedDays.includes(bookingDay)) {
    return "";
  }

  return doctor.availability_note
    ? `Doctor unavailable on ${bookingDay}. ${doctor.availability_note}`
    : `Doctor unavailable on ${bookingDay}.`;
}

async function getDoctorLeaveMessage(client, doctorId, date) {
  const result = await client.query(
    `SELECT reason
     FROM doctor_leaves
     WHERE doctor_id = $1
       AND leave_date = $2
     LIMIT 1`,
    [doctorId, date]
  );

  if (!result.rows[0]) {
    return "";
  }

  return result.rows[0].reason
    ? `Doctor is on leave on ${date}. ${result.rows[0].reason}`
    : `Doctor is on leave on ${date}.`;
}

function getDateDayIndex(value) {
  return new Date(`${value}T12:00:00`).getDay();
}

async function getActiveAppointmentCount(client, doctorId, date, excludeAppointmentId = null) {
  const values = [doctorId, date];
  let excludeClause = "";

  if (excludeAppointmentId) {
    values.push(excludeAppointmentId);
    excludeClause = ` AND id <> $${values.length}`;
  }

  const result = await client.query(
    `SELECT COUNT(*)::int AS active_appointments
     FROM appointments
     WHERE doctor_id = $1
       AND appointment_date = $2
       AND COALESCE(status, 'booked') <> 'cancelled'
       ${excludeClause}`,
    values
  );

  return Number(result.rows[0]?.active_appointments || 0);
}

async function getBookedSlotNumbers(client, doctorId, date, excludeAppointmentId = null) {
  const values = [doctorId, date];
  let condition = "";

  if (excludeAppointmentId) {
    values.push(excludeAppointmentId);
    condition = ` AND id <> $${values.length}`;
  }

  const result = await client.query(
    `SELECT COALESCE(slot_number, token_number) AS slot_number
     FROM appointments
     WHERE doctor_id = $1
       AND appointment_date = $2
       AND COALESCE(status, 'booked') <> 'cancelled'
       ${condition}`,
    values
  );

  return new Set(result.rows.map((row) => Number(row.slot_number)));
}

async function getNextTokenNumber(client, doctorId, date, excludeAppointmentId = null) {
  const values = [doctorId, date];
  let excludeClause = "";

  if (excludeAppointmentId) {
    values.push(excludeAppointmentId);
    excludeClause = ` AND id <> $${values.length}`;
  }

  const result = await client.query(
    `SELECT COALESCE(MAX(token_number), 0)::int + 1 AS next_token
     FROM appointments
     WHERE doctor_id = $1
       AND appointment_date = $2
       ${excludeClause}`,
    values
  );

  return Number(result.rows[0]?.next_token || 1);
}

/** Link the booking to a patient record: an owned patient_id, or find/create one for this person. */
async function resolveBookingPatient(client, req, { name, mobile, familyMember }) {
  const { patient } = await resolvePatient(
    client,
    req.user.id,
    {
      name,
      phone: mobile,
      date_of_birth: familyMember ? null : req.body.date_of_birth,
      gender: req.body.gender,
      email: req.body.email || (familyMember ? null : req.user.email),
    },
    { relation: familyMember?.relation || "self", familyMemberId: familyMember?.id || null }
  );
  return patient.id;
}

async function getFamilyMember(client, familyMemberId, userId) {
  const result = await client.query(
    `SELECT id, name, relation
     FROM family_members
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [familyMemberId, userId]
  );

  return result.rows[0] || null;
}

module.exports = {
  cancelAppointment,
  checkInAppointment,
  createAppointment,
  rescheduleAppointment,
};
