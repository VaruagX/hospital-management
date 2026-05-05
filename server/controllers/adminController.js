const pool = require("../config/db");
const { ACTIVE_QUEUE_STATUSES } = require("../utils/slots");

async function getAdminDashboard(req, res, next) {
  try {
    const statsResult = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM hospitals)::int AS total_hospitals,
         (SELECT COUNT(*) FROM doctors)::int AS total_doctors,
         (SELECT COUNT(*) FROM appointments)::int AS total_appointments,
         (SELECT COUNT(*) FROM cities)::int AS total_cities`
    );

    const chartResult = await pool.query(
      `SELECT h.name, COUNT(a.id)::int AS bookings
       FROM hospitals h
       LEFT JOIN appointments a ON a.hospital_id = h.id
       GROUP BY h.id
       ORDER BY bookings DESC, h.name
       LIMIT 6`
    );

    res.json({
      stats: statsResult.rows[0],
      chart: chartResult.rows,
    });
  } catch (error) {
    next(error);
  }
}

async function getAdminCities(req, res, next) {
  try {
    const result = await pool.query("SELECT id, name FROM cities ORDER BY name");
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function addCity(req, res, next) {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "City name is required" });
    }

    const normalizedName = name.trim();
    const existingResult = await pool.query(
      "SELECT id, name FROM cities WHERE LOWER(name) = LOWER($1) LIMIT 1",
      [normalizedName]
    );

    if (existingResult.rows[0]) {
      return res.status(409).json({ error: "City already exists" });
    }

    const result = await pool.query(
      "INSERT INTO cities (name) VALUES ($1) RETURNING id, name",
      [normalizedName]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getAdminHospitals(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT h.id, h.name, h.location, h.image, h.city_id, h.contact_phone, h.map_link,
              c.name AS city_name,
              COUNT(d.id)::int AS doctor_count
       FROM hospitals h
       JOIN cities c ON c.id = h.city_id
       LEFT JOIN doctors d ON d.hospital_id = h.id
       GROUP BY h.id, c.name
       ORDER BY c.name, h.name`
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function getAdminDoctors(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT d.id, d.name, d.specialization, d.image, d.available_from, d.available_to,
              d.slot_step_minutes, d.slot_duration_minutes,
              d.unavailable_days, d.availability_note,
              d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              c.name AS city_name
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       JOIN cities c ON c.id = h.city_id
       ORDER BY d.name`
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function getAdminAppointments(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT a.id,
              a.user_name,
              a.mobile,
              TO_CHAR(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
              a.token_number,
              a.status,
              d.id AS doctor_id,
              d.name AS doctor_name,
              d.specialization,
              h.name AS hospital_name,
              h.location AS hospital_location,
              c.name AS city_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN hospitals h ON h.id = a.hospital_id
       JOIN cities c ON c.id = h.city_id
       ORDER BY a.appointment_date DESC, h.name, d.name, a.token_number`
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function updateAppointmentStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowedStatuses = ["serving", "completed", "skipped", "booked"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid appointment status" });
    }

    const result = await pool.query(
      `UPDATE appointments
       SET status = $1
       WHERE id = $2
       RETURNING id, status`,
      [status, id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getTodayBoard(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT
         d.id AS doctor_id,
         d.name AS doctor_name,
         d.specialization,
         h.name AS hospital_name,
         a.id AS appointment_id,
         a.token_number,
         a.user_name,
         a.status
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       LEFT JOIN appointments a
         ON a.doctor_id = d.id
        AND a.appointment_date = CURRENT_DATE
       ORDER BY d.name, a.token_number`
    );

    const grouped = new Map();
    for (const row of result.rows) {
      if (!grouped.has(row.doctor_id)) {
        grouped.set(row.doctor_id, {
          doctor_id: row.doctor_id,
          doctor_name: row.doctor_name,
          specialization: row.specialization,
          hospital_name: row.hospital_name,
          now_serving:
            null,
          appointments: [],
        });
      }

      const doctor = grouped.get(row.doctor_id);
      if (row.appointment_id) {
        doctor.appointments.push({
          appointment_id: row.appointment_id,
          token_number: row.token_number,
          user_name: row.user_name,
          status: row.status,
        });
      }
    }

    for (const doctor of grouped.values()) {
      const activeTokens = doctor.appointments
        .filter((item) => ACTIVE_QUEUE_STATUSES.includes((item.status || "").toLowerCase()))
        .map((item) => item.token_number)
        .sort((a, b) => a - b);
      doctor.now_serving = activeTokens.length ? activeTokens[0] : null;
    }

    res.json(Array.from(grouped.values()));
  } catch (error) {
    next(error);
  }
}

async function getDoctorToday(req, res, next) {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT
         d.id AS doctor_id,
         d.name AS doctor_name,
         d.specialization,
         h.name AS hospital_name,
         a.id AS appointment_id,
         a.token_number,
         a.user_name,
         a.mobile,
         a.status
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       LEFT JOIN appointments a
         ON a.doctor_id = d.id
        AND a.appointment_date = CURRENT_DATE
       WHERE d.id = $1
       ORDER BY a.token_number`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const doctor = {
      doctor_id: result.rows[0].doctor_id,
      doctor_name: result.rows[0].doctor_name,
      specialization: result.rows[0].specialization,
      hospital_name: result.rows[0].hospital_name,
      appointments: result.rows
        .filter((row) => row.appointment_id)
        .map((row) => ({
          appointment_id: row.appointment_id,
          token_number: row.token_number,
          user_name: row.user_name,
          mobile: row.mobile,
          status: row.status,
        })),
    };

    const activeTokens = doctor.appointments
      .filter((item) => ACTIVE_QUEUE_STATUSES.includes((item.status || "").toLowerCase()))
      .map((item) => item.token_number)
      .sort((a, b) => a - b);
    doctor.now_serving = activeTokens.length ? activeTokens[0] : null;

    res.json(doctor);
  } catch (error) {
    next(error);
  }
}

async function addHospital(req, res, next) {
  try {
    const { name, city_id: cityId, location, image, contact_phone: contactPhone, map_link: mapLink } = req.body;
    if (!name || !cityId || !location) {
      return res.status(400).json({ error: "Name, city, and location are required" });
    }

    const result = await pool.query(
      `INSERT INTO hospitals (name, city_id, location, image, contact_phone, map_link)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, cityId, location, image || null, contactPhone || "", mapLink || ""]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function addDoctor(req, res, next) {
  try {
    const {
      name,
      specialization,
      hospital_id: hospitalId,
      available_from: availableFrom,
      available_to: availableTo,
      slot_step_minutes: slotStepMinutes,
      slot_duration_minutes: slotDurationMinutes,
      unavailable_days: unavailableDays,
      availability_note: availabilityNote,
      image,
    } = req.body;

    if (!name || !specialization || !hospitalId || !availableFrom || !availableTo) {
      return res.status(400).json({ error: "All doctor fields are required" });
    }

    const result = await pool.query(
      `INSERT INTO doctors (
         name, specialization, hospital_id, image, available_from, available_to, slot_step_minutes, slot_duration_minutes, unavailable_days, availability_note
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        name,
        specialization,
        hospitalId,
        image || null,
        availableFrom,
        availableTo,
        Number(slotStepMinutes) || 15,
        Number(slotDurationMinutes) || 15,
        unavailableDays || "",
        availabilityNote || "",
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function updateDoctor(req, res, next) {
  try {
    const { id } = req.params;
    const {
      name,
      specialization,
      hospital_id: hospitalId,
      available_from: availableFrom,
      available_to: availableTo,
      slot_step_minutes: slotStepMinutes,
      slot_duration_minutes: slotDurationMinutes,
      unavailable_days: unavailableDays,
      availability_note: availabilityNote,
      image,
    } = req.body;

    if (!name || !specialization || !hospitalId || !availableFrom || !availableTo) {
      return res.status(400).json({ error: "All doctor fields are required" });
    }

    const result = await pool.query(
      `UPDATE doctors
       SET name = $1,
           specialization = $2,
           hospital_id = $3,
           image = $4,
           available_from = $5,
           available_to = $6,
           slot_step_minutes = $7,
           slot_duration_minutes = $8,
           unavailable_days = $9,
           availability_note = $10
       WHERE id = $11
       RETURNING *`,
      [
        name,
        specialization,
        hospitalId,
        image || null,
        availableFrom,
        availableTo,
        Number(slotStepMinutes) || 15,
        Number(slotDurationMinutes) || 15,
        unavailableDays || "",
        availabilityNote || "",
        id,
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function deleteHospital(req, res, next) {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    await client.query("BEGIN");
    await client.query("DELETE FROM appointments WHERE hospital_id = $1", [id]);
    await client.query("DELETE FROM doctors WHERE hospital_id = $1", [id]);
    const result = await client.query("DELETE FROM hospitals WHERE id = $1 RETURNING id", [id]);
    await client.query("COMMIT");

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Hospital not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function deleteDoctor(req, res, next) {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    await client.query("BEGIN");
    await client.query("DELETE FROM appointments WHERE doctor_id = $1", [id]);
    const result = await client.query("DELETE FROM doctors WHERE id = $1 RETURNING id", [id]);
    await client.query("COMMIT");

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

module.exports = {
  getAdminDashboard,
  getAdminCities,
  addCity,
  getAdminHospitals,
  getAdminDoctors,
  getAdminAppointments,
  updateAppointmentStatus,
  getTodayBoard,
  getDoctorToday,
  addHospital,
  addDoctor,
  updateDoctor,
  deleteHospital,
  deleteDoctor,
};
