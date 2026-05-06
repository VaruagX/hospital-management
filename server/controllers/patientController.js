const pool = require("../config/db");
const {
  buildDoctorSlots,
  normalizeTime,
} = require("../utils/slots");

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

async function getDoctorSlots(req, res, next) {
  try {
    const { doctorId } = req.params;
    const { date, excludeAppointmentId } = req.query;

    if (!date) {
      return res.status(400).json({ error: "Date is required" });
    }

    const doctorResult = await pool.query(
      `SELECT id, name, available_from, available_to, slot_step_minutes, slot_duration_minutes,
              unavailable_days, availability_note, max_patients_per_day
       FROM doctors
       WHERE id = $1
       LIMIT 1`,
      [doctorId]
    );

    const doctor = doctorResult.rows[0];
    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const requestedDay = DAY_NAMES[new Date(`${date}T12:00:00`).getDay()];
    const blockedDays = String(doctor.unavailable_days || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const weeklyUnavailable = blockedDays.includes(requestedDay);

    const leaveResult = await pool.query(
      `SELECT reason
       FROM doctor_leaves
       WHERE doctor_id = $1
         AND leave_date = $2
       LIMIT 1`,
      [doctorId, date]
    );
    const leave = leaveResult.rows[0] || null;
    const unavailable = weeklyUnavailable || Boolean(leave);

    const values = [doctorId, date];
    let excludeClause = "";
    if (excludeAppointmentId) {
      values.push(excludeAppointmentId);
      excludeClause = ` AND id <> $${values.length}`;
    }

    const bookedSlotsResult = await pool.query(
      `SELECT COALESCE(slot_number, token_number)::int AS slot_number,
              COALESCE(token_number, 0)::int AS token_number,
              COALESCE(status, 'booked') AS status
       FROM appointments
       WHERE doctor_id = $1
         AND appointment_date = $2
         ${excludeClause}`,
      values
    );

    const activeRows = bookedSlotsResult.rows.filter(
      (row) => String(row.status || "").toLowerCase() !== "cancelled"
    );
    const bookedSlots = new Set(activeRows.map((row) => Number(row.slot_number)));
    const nextTokenNumber =
      bookedSlotsResult.rows.reduce(
        (maxToken, row) => Math.max(maxToken, Number(row.token_number) || 0),
        0
      ) + 1;
    const limitReached =
      Number(doctor.max_patients_per_day || 0) > 0 &&
      activeRows.length >= Number(doctor.max_patients_per_day);
    const slots = buildDoctorSlots({
      availableFrom: doctor.available_from,
      availableTo: doctor.available_to,
      slotStepMinutes: doctor.slot_step_minutes,
      slotDurationMinutes: doctor.slot_duration_minutes,
    }).map((slot) => ({
      slotNumber: slot.slotNumber,
      startTime: normalizeTime(slot.startTime),
      endTime: normalizeTime(slot.endTime),
      label: `${normalizeTime(slot.startTime)} to ${normalizeTime(slot.endTime)}`,
      isBooked: bookedSlots.has(slot.slotNumber),
    }));
    const nextSlot = unavailable
      ? null
      : limitReached
        ? null
        : slots.find((slot) => slot.slotNumber === nextTokenNumber) || null;

    return res.json({
      doctorId: Number(doctorId),
      date,
      unavailable,
      limitReached,
      bookedPatients: activeRows.length,
      maxPatientsPerDay: Number(doctor.max_patients_per_day || 0),
      nextSlot,
      note: unavailable
        ? leave?.reason ||
          doctor.availability_note ||
          `${doctor.name} is unavailable on ${requestedDay}.`
        : limitReached
          ? `Daily booking limit of ${doctor.max_patients_per_day} patients has been reached.`
        : "",
      slots,
    });
  } catch (error) {
    return next(error);
  }
}

async function getFavorites(req, res, next) {
  try {
    const [doctorFavorites, hospitalFavorites] = await Promise.all([
      pool.query(
        `SELECT d.id, d.name, d.specialization, d.image, d.hospital_id,
                d.department_id, dep.name AS department_name,
                h.city_id,
                h.name AS hospital_name, h.location AS hospital_location,
                c.name AS city_name
         FROM favorite_doctors fd
         JOIN doctors d ON d.id = fd.doctor_id
         JOIN hospitals h ON h.id = d.hospital_id
         JOIN cities c ON c.id = h.city_id
         LEFT JOIN departments dep ON dep.id = d.department_id
         WHERE fd.user_id = $1
         ORDER BY d.name`,
        [req.user.id]
      ),
      pool.query(
        `SELECT h.id, h.name, h.location, h.image, h.city_id, c.name AS city_name
         FROM favorite_hospitals fh
         JOIN hospitals h ON h.id = fh.hospital_id
         JOIN cities c ON c.id = h.city_id
         WHERE fh.user_id = $1
         ORDER BY h.name`,
        [req.user.id]
      ),
    ]);

    return res.json({
      doctors: doctorFavorites.rows,
      hospitals: hospitalFavorites.rows,
    });
  } catch (error) {
    return next(error);
  }
}

async function toggleFavoriteDoctor(req, res, next) {
  try {
    const { doctorId } = req.params;
    const existing = await pool.query(
      `SELECT 1
       FROM favorite_doctors
       WHERE user_id = $1 AND doctor_id = $2`,
      [req.user.id, doctorId]
    );

    if (existing.rows[0]) {
      await pool.query(
        `DELETE FROM favorite_doctors
         WHERE user_id = $1 AND doctor_id = $2`,
        [req.user.id, doctorId]
      );
      return res.json({ favorite: false });
    }

    await pool.query(
      `INSERT INTO favorite_doctors (user_id, doctor_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, doctorId]
    );
    return res.json({ favorite: true });
  } catch (error) {
    return next(error);
  }
}

async function toggleFavoriteHospital(req, res, next) {
  try {
    const { hospitalId } = req.params;
    const existing = await pool.query(
      `SELECT 1
       FROM favorite_hospitals
       WHERE user_id = $1 AND hospital_id = $2`,
      [req.user.id, hospitalId]
    );

    if (existing.rows[0]) {
      await pool.query(
        `DELETE FROM favorite_hospitals
         WHERE user_id = $1 AND hospital_id = $2`,
        [req.user.id, hospitalId]
      );
      return res.json({ favorite: false });
    }

    await pool.query(
      `INSERT INTO favorite_hospitals (user_id, hospital_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, hospitalId]
    );
    return res.json({ favorite: true });
  } catch (error) {
    return next(error);
  }
}

async function getFamilyMembers(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT id, name, relation
       FROM family_members
       WHERE user_id = $1
       ORDER BY name`,
      [req.user.id]
    );

    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
}

async function addFamilyMember(req, res, next) {
  try {
    const { name, relation } = req.body;

    if (!name || !relation) {
      return res.status(400).json({ error: "Family member name and relation are required" });
    }

    const result = await pool.query(
      `INSERT INTO family_members (user_id, name, relation)
       VALUES ($1, $2, $3)
       RETURNING id, name, relation`,
      [req.user.id, String(name).trim(), String(relation).trim()]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  addFamilyMember,
  getDoctorSlots,
  getFamilyMembers,
  getFavorites,
  toggleFavoriteDoctor,
  toggleFavoriteHospital,
};
