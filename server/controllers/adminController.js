const pool = require("../config/db");
const { ACTIVE_QUEUE_STATUSES } = require("../utils/slots");
const PRIORITY_ORDER_SQL = `CASE WHEN COALESCE(a.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END`;

function normalizePriority(priority) {
  return String(priority || "normal").toLowerCase() === "emergency"
    ? "emergency"
    : "normal";
}

function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function buildAppointmentFilterQuery(filters = {}) {
  const clauses = [];
  const values = [];

  if (filters.date) {
    values.push(filters.date);
    clauses.push(`a.appointment_date = $${values.length}`);
  }

  if (filters.hospital) {
    values.push(filters.hospital);
    clauses.push(`h.id = $${values.length}`);
  }

  if (filters.doctor) {
    values.push(filters.doctor);
    clauses.push(`d.id = $${values.length}`);
  }

  if (filters.status) {
    values.push(String(filters.status).toLowerCase());
    clauses.push(`LOWER(COALESCE(a.status, 'booked')) = $${values.length}`);
  }

  if (filters.priority) {
    values.push(normalizePriority(filters.priority));
    clauses.push(`COALESCE(a.priority, 'normal') = $${values.length}`);
  }

  return {
    values,
    whereClause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
  };
}

async function fetchAdminAppointments(filters = {}) {
  const { values, whereClause } = buildAppointmentFilterQuery(filters);
  const result = await pool.query(
    `SELECT a.id,
            a.user_name,
            a.mobile,
            TO_CHAR(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
            a.token_number,
            a.status,
            COALESCE(a.priority, 'normal') AS priority,
            a.reason_for_visit,
            a.visit_notes,
            d.id AS doctor_id,
            d.name AS doctor_name,
            d.specialization,
            d.max_patients_per_day,
            dep.id AS department_id,
            dep.name AS department_name,
            h.id AS hospital_id,
            h.name AS hospital_name,
            h.location AS hospital_location,
            c.name AS city_name
     FROM appointments a
     JOIN doctors d ON d.id = a.doctor_id
     JOIN hospitals h ON h.id = a.hospital_id
     JOIN cities c ON c.id = h.city_id
     LEFT JOIN departments dep ON dep.id = d.department_id
     ${whereClause}
     ORDER BY a.appointment_date DESC,
              h.name,
              d.name,
              ${PRIORITY_ORDER_SQL},
              a.token_number`,
    values
  );

  return result.rows;
}

async function getAdminDashboard(req, res, next) {
  try {
    const [statsResult, bookingsPerDayResult, topDoctorsResult, topHospitalsResult] =
      await Promise.all([
        pool.query(
          `SELECT
             (SELECT COUNT(*) FROM hospitals)::int AS total_hospitals,
             (SELECT COUNT(*) FROM doctors)::int AS total_doctors,
             (SELECT COUNT(*) FROM appointments)::int AS total_appointments,
             (SELECT COUNT(*) FROM cities)::int AS total_cities`
        ),
        pool.query(
          `SELECT TO_CHAR(appointment_date, 'YYYY-MM-DD') AS label,
                  COUNT(*)::int AS value
           FROM appointments
           WHERE appointment_date >= CURRENT_DATE - INTERVAL '13 days'
           GROUP BY appointment_date
           ORDER BY appointment_date`
        ),
        pool.query(
          `SELECT d.id,
                  d.name AS label,
                  COUNT(a.id)::int AS value
           FROM doctors d
           LEFT JOIN appointments a ON a.doctor_id = d.id
           GROUP BY d.id, d.name
           ORDER BY value DESC, d.name
           LIMIT 6`
        ),
        pool.query(
          `SELECT h.id,
                  h.name AS label,
                  COUNT(a.id)::int AS value
           FROM hospitals h
           LEFT JOIN appointments a ON a.hospital_id = h.id
           GROUP BY h.id, h.name
           ORDER BY value DESC, h.name
           LIMIT 6`
        ),
      ]);

    res.json({
      stats: statsResult.rows[0],
      charts: {
        bookingsPerDay: bookingsPerDayResult.rows,
        topDoctors: topDoctorsResult.rows,
        topHospitals: topHospitalsResult.rows,
      },
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

async function getAdminDepartments(req, res, next) {
  try {
    const result = await pool.query(
      "SELECT id, name FROM departments ORDER BY name"
    );
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

async function addHospital(req, res, next) {
  try {
    const {
      name,
      city_id: cityId,
      location,
      image,
      contact_phone: contactPhone,
      map_link: mapLink,
    } = req.body;

    if (!name || !cityId || !location) {
      return res.status(400).json({ error: "Name, city, and location are required" });
    }

    const result = await pool.query(
      `INSERT INTO hospitals (name, city_id, location, image, contact_phone, map_link)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name.trim(), cityId, location.trim(), image || null, contactPhone || "", mapLink || ""]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function updateHospital(req, res, next) {
  try {
    const { id } = req.params;
    const {
      name,
      city_id: cityId,
      location,
      image,
      contact_phone: contactPhone,
      map_link: mapLink,
    } = req.body;

    if (!name || !cityId || !location) {
      return res.status(400).json({ error: "Name, city, and location are required" });
    }

    const result = await pool.query(
      `UPDATE hospitals
       SET name = $1,
           city_id = $2,
           location = $3,
           image = $4,
           contact_phone = $5,
           map_link = $6
       WHERE id = $7
       RETURNING *`,
      [name.trim(), cityId, location.trim(), image || null, contactPhone || "", mapLink || "", id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Hospital not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getAdminDoctors(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT d.id, d.name, d.specialization, d.image, d.available_from, d.available_to,
              d.slot_step_minutes, d.slot_duration_minutes,
              d.unavailable_days, d.availability_note,
              d.department_id, dep.name AS department_name,
              d.max_patients_per_day,
              d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              c.name AS city_name
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       JOIN cities c ON c.id = h.city_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       ORDER BY d.name`
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function addDoctor(req, res, next) {
  try {
    const {
      name,
      specialization,
      department_id: departmentId,
      hospital_id: hospitalId,
      available_from: availableFrom,
      available_to: availableTo,
      slot_step_minutes: slotStepMinutes,
      slot_duration_minutes: slotDurationMinutes,
      unavailable_days: unavailableDays,
      availability_note: availabilityNote,
      max_patients_per_day: maxPatientsPerDay,
      image,
    } = req.body;
    const normalizedMaxPatients = parsePositiveInt(maxPatientsPerDay, 24);

    if (!name || !specialization || !departmentId || !hospitalId || !availableFrom || !availableTo) {
      return res.status(400).json({ error: "All doctor fields are required" });
    }

    if (!normalizedMaxPatients) {
      return res.status(400).json({ error: "Max patients per day must be a positive number" });
    }

    const result = await pool.query(
      `INSERT INTO doctors (
         name, specialization, department_id, hospital_id, image, available_from, available_to,
         slot_step_minutes, slot_duration_minutes, unavailable_days, availability_note, max_patients_per_day
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        name,
        specialization,
        departmentId,
        hospitalId,
        image || null,
        availableFrom,
        availableTo,
        Number(slotStepMinutes) || 15,
        Number(slotDurationMinutes) || 15,
        unavailableDays || "",
        availabilityNote || "",
        normalizedMaxPatients,
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
      department_id: departmentId,
      hospital_id: hospitalId,
      available_from: availableFrom,
      available_to: availableTo,
      slot_step_minutes: slotStepMinutes,
      slot_duration_minutes: slotDurationMinutes,
      unavailable_days: unavailableDays,
      availability_note: availabilityNote,
      max_patients_per_day: maxPatientsPerDay,
      image,
    } = req.body;
    const normalizedMaxPatients = parsePositiveInt(maxPatientsPerDay, 24);

    if (!name || !specialization || !departmentId || !hospitalId || !availableFrom || !availableTo) {
      return res.status(400).json({ error: "All doctor fields are required" });
    }

    if (!normalizedMaxPatients) {
      return res.status(400).json({ error: "Max patients per day must be a positive number" });
    }

    const result = await pool.query(
      `UPDATE doctors
       SET name = $1,
           specialization = $2,
           department_id = $3,
           hospital_id = $4,
           image = $5,
           available_from = $6,
           available_to = $7,
           slot_step_minutes = $8,
           slot_duration_minutes = $9,
           unavailable_days = $10,
           availability_note = $11,
           max_patients_per_day = $12
       WHERE id = $13
       RETURNING *`,
      [
        name,
        specialization,
        departmentId,
        hospitalId,
        image || null,
        availableFrom,
        availableTo,
        Number(slotStepMinutes) || 15,
        Number(slotDurationMinutes) || 15,
        unavailableDays || "",
        availabilityNote || "",
        normalizedMaxPatients,
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

async function getDoctorLeaves(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT dl.id,
              dl.doctor_id,
              TO_CHAR(dl.leave_date, 'YYYY-MM-DD') AS leave_date,
              dl.reason,
              d.name AS doctor_name,
              d.specialization,
              h.name AS hospital_name
       FROM doctor_leaves dl
       JOIN doctors d ON d.id = dl.doctor_id
       JOIN hospitals h ON h.id = d.hospital_id
       ORDER BY dl.leave_date DESC, d.name`
    );

    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function addDoctorLeave(req, res, next) {
  try {
    const { doctor_id: doctorId, leave_date: leaveDate, reason } = req.body;

    if (!doctorId || !leaveDate) {
      return res.status(400).json({ error: "Doctor and leave date are required" });
    }

    const result = await pool.query(
      `INSERT INTO doctor_leaves (doctor_id, leave_date, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (doctor_id, leave_date)
       DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id, doctor_id, TO_CHAR(leave_date, 'YYYY-MM-DD') AS leave_date, reason`,
      [doctorId, leaveDate, reason || ""]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
}

async function deleteDoctorLeave(req, res, next) {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM doctor_leaves WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Doctor leave not found" });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

async function getAdminAppointments(req, res, next) {
  try {
    const appointments = await fetchAdminAppointments(req.query);
    res.json(appointments);
  } catch (error) {
    next(error);
  }
}

async function exportAdminAppointmentsCsv(req, res, next) {
  try {
    const appointments = await fetchAdminAppointments(req.query);
    const rows = [
      [
        "Patient",
        "Mobile",
        "Hospital",
        "Doctor",
        "Department",
        "Date",
        "Token",
        "Priority",
        "Reason for Visit",
        "Visit Notes",
        "Status",
      ],
      ...appointments.map((appointment) => [
        appointment.user_name,
        appointment.mobile,
        appointment.hospital_name,
        appointment.doctor_name,
        appointment.department_name,
        appointment.appointment_date,
        appointment.token_number,
        appointment.priority,
        appointment.reason_for_visit,
        appointment.visit_notes,
        appointment.status,
      ]),
    ];

    const csv = rows
      .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="appointments-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(csv);
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

async function updateAppointmentNotes(req, res, next) {
  try {
    const { id } = req.params;
    const visitNotes = String(req.body.visit_notes || "").trim();
    const appointmentResult = await pool.query(
      `SELECT id,
              status,
              (appointment_date <= CURRENT_DATE) AS notes_allowed
       FROM appointments
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

    const appointment = appointmentResult.rows[0];
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    if (String(appointment.status || "").toLowerCase() === "cancelled") {
      return res.status(400).json({ error: "Cancelled appointments cannot store visit notes" });
    }

    if (!appointment.notes_allowed) {
      return res.status(400).json({ error: "Visit notes can be added only on or after the appointment date" });
    }

    const result = await pool.query(
      `UPDATE appointments
       SET visit_notes = $1
       WHERE id = $2
       RETURNING id, visit_notes`,
      [visitNotes || null, id]
    );

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
         dep.name AS department_name,
         h.name AS hospital_name,
         a.id AS appointment_id,
         a.token_number,
         a.user_name,
         COALESCE(a.priority, 'normal') AS priority,
         a.reason_for_visit,
         a.visit_notes,
         a.status
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN appointments a
         ON a.doctor_id = d.id
        AND a.appointment_date = CURRENT_DATE
       ORDER BY d.name,
                CASE WHEN COALESCE(a.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END,
                a.token_number`
    );

    const grouped = new Map();
    for (const row of result.rows) {
      if (!grouped.has(row.doctor_id)) {
        grouped.set(row.doctor_id, {
          doctor_id: row.doctor_id,
          doctor_name: row.doctor_name,
          specialization: row.specialization,
          department_name: row.department_name,
          hospital_name: row.hospital_name,
          now_serving: null,
          appointments: [],
        });
      }

      const doctor = grouped.get(row.doctor_id);
      if (row.appointment_id) {
        doctor.appointments.push({
          appointment_id: row.appointment_id,
          token_number: row.token_number,
          user_name: row.user_name,
          priority: row.priority,
          reason_for_visit: row.reason_for_visit,
          visit_notes: row.visit_notes,
          status: row.status,
        });
      }
    }

    for (const doctor of grouped.values()) {
      const activeTokens = doctor.appointments
        .filter((item) => ACTIVE_QUEUE_STATUSES.includes((item.status || "").toLowerCase()))
        .sort((left, right) => {
          if (normalizePriority(left.priority) !== normalizePriority(right.priority)) {
            return normalizePriority(left.priority) === "emergency" ? -1 : 1;
          }

          return Number(left.token_number) - Number(right.token_number);
        });
      doctor.now_serving = activeTokens.length ? activeTokens[0].token_number : null;
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
         dep.name AS department_name,
         h.name AS hospital_name,
         a.id AS appointment_id,
         a.token_number,
         a.user_name,
         a.mobile,
         COALESCE(a.priority, 'normal') AS priority,
         a.reason_for_visit,
         a.visit_notes,
         a.status
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN appointments a
         ON a.doctor_id = d.id
        AND a.appointment_date = CURRENT_DATE
       WHERE d.id = $1
       ORDER BY CASE WHEN COALESCE(a.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END,
                a.token_number`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const doctor = {
      doctor_id: result.rows[0].doctor_id,
      doctor_name: result.rows[0].doctor_name,
      specialization: result.rows[0].specialization,
      department_name: result.rows[0].department_name,
      hospital_name: result.rows[0].hospital_name,
      appointments: result.rows
        .filter((row) => row.appointment_id)
        .map((row) => ({
          appointment_id: row.appointment_id,
          token_number: row.token_number,
          user_name: row.user_name,
          mobile: row.mobile,
          priority: row.priority,
          reason_for_visit: row.reason_for_visit,
          visit_notes: row.visit_notes,
          status: row.status,
        })),
    };

    const activeTokens = doctor.appointments
      .filter((item) => ACTIVE_QUEUE_STATUSES.includes((item.status || "").toLowerCase()))
      .sort((left, right) => {
        if (normalizePriority(left.priority) !== normalizePriority(right.priority)) {
          return normalizePriority(left.priority) === "emergency" ? -1 : 1;
        }

        return Number(left.token_number) - Number(right.token_number);
      });
    doctor.now_serving = activeTokens.length ? activeTokens[0].token_number : null;

    res.json(doctor);
  } catch (error) {
    next(error);
  }
}

async function deleteHospital(req, res, next) {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM doctor_leaves
       WHERE doctor_id IN (SELECT id FROM doctors WHERE hospital_id = $1)`,
      [id]
    );
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
    await client.query("DELETE FROM doctor_leaves WHERE doctor_id = $1", [id]);
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
  addCity,
  addDoctor,
  addDoctorLeave,
  addHospital,
  deleteDoctor,
  deleteDoctorLeave,
  deleteHospital,
  exportAdminAppointmentsCsv,
  getAdminAppointments,
  getAdminCities,
  getAdminDepartments,
  getAdminDashboard,
  getAdminDoctors,
  getAdminHospitals,
  getDoctorLeaves,
  getDoctorToday,
  getTodayBoard,
  updateAppointmentNotes,
  updateAppointmentStatus,
  updateDoctor,
  updateHospital,
};
