const pool = require("../config/db");
const { sendAppointmentReminder, canSendMail } = require("./mailService");
const { normalizeTime } = require("../utils/slots");

const REMINDER_WINDOW_MINUTES = 120;
let running = false;

async function runReminderCycle() {
  if (running || !canSendMail()) {
    return;
  }

  running = true;

  try {
    const result = await pool.query(
      `SELECT a.id,
              u.email,
              u.name AS patient_name,
              a.user_name AS booking_name,
              TO_CHAR(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
              TO_CHAR(a.slot_start, 'HH24:MI') AS slot_start,
              TO_CHAR(a.slot_end, 'HH24:MI') AS slot_end,
              d.name AS doctor_name,
              h.name AS hospital_name
       FROM appointments a
       JOIN users u ON u.id = a.user_id
       JOIN doctors d ON d.id = a.doctor_id
       JOIN hospitals h ON h.id = a.hospital_id
       WHERE a.reminder_sent_at IS NULL
         AND COALESCE(a.status, 'booked') IN ('booked', 'pending')
         AND a.appointment_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '1 day'
         AND a.slot_start IS NOT NULL
       ORDER BY a.appointment_date, a.slot_start`
    );

    const now = new Date();

    for (const appointment of result.rows) {
      const appointmentTime = new Date(
        `${appointment.appointment_date}T${normalizeTime(appointment.slot_start)}:00`
      );
      const diffMinutes = (appointmentTime.getTime() - now.getTime()) / (1000 * 60);

      if (diffMinutes <= 0 || diffMinutes > REMINDER_WINDOW_MINUTES) {
        continue;
      }

      await sendAppointmentReminder({
        email: appointment.email,
        patientName: appointment.patient_name,
        bookingName: appointment.booking_name,
        hospitalName: appointment.hospital_name,
        doctorName: appointment.doctor_name,
        appointmentDate: appointment.appointment_date,
        slotLabel: `${normalizeTime(appointment.slot_start)} to ${normalizeTime(appointment.slot_end)}`,
      });

      await pool.query(
        `UPDATE appointments
         SET reminder_sent_at = NOW()
         WHERE id = $1`,
        [appointment.id]
      );
    }
  } catch (error) {
    console.error("Reminder cycle failed", error);
  } finally {
    running = false;
  }
}

function startReminderScheduler() {
  setTimeout(() => {
    runReminderCycle().catch(() => {});
  }, 15000);

  setInterval(() => {
    runReminderCycle().catch(() => {});
  }, 5 * 60 * 1000);
}

module.exports = {
  runReminderCycle,
  startReminderScheduler,
};
