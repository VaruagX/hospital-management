const pool = require("../config/db");
const { ACTIVE_QUEUE_STATUSES } = require("../utils/slots");
const { audit } = require("../services/audit");
const v = require("../utils/validate");
const {
  scopeOf,
  applyAppointmentScope,
  canAccessDoctor,
  canAccessAppointment,
} = require("../policies/access");

function parseId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// Validated optional/extended doctor fields shared by create and update.
function doctorExtras(body) {
  const availableFrom = v.time(body.available_from, "Available from");
  const availableTo = v.time(body.available_to, "Available to");
  if (availableFrom && availableTo && availableFrom >= availableTo) {
    throw badRequest("Available-to time must be after available-from time");
  }
  const slotStep = v.intRange(body.slot_step_minutes, "Slot step", 5, 240) ?? 15;
  const slotDuration = v.intRange(body.slot_duration_minutes, "Consultation duration", 5, 240) ?? 15;
  return {
    availableFrom,
    availableTo,
    slotStep,
    slotDuration,
    image: v.imageRef(body.image, "Doctor photo"),
    qualification: v.text(body.qualification, "Qualification", { max: 300 }),
    experienceYears: v.intRange(body.experience_years, "Experience", 0, 80),
    fee: v.money(body.consultation_fee, "Consultation fee"),
  };
}

// Clinical notes are visible to the treating doctor and global admins only.
function canSeeNotes(user) {
  const scope = scopeOf(user);
  return Boolean(scope && (scope.all || scope.doctorId));
}

function forbidden(res) {
  return res
    .status(403)
    .json({ error: "Your account is not assigned to a hospital or doctor profile" });
}
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

function buildAppointmentFilterQuery(filters = {}, user = null) {
  const clauses = [];
  const values = [];

  // Role/hospital/doctor scoping is applied first and cannot be widened by query params.
  if (user && !applyAppointmentScope(user, clauses, values)) {
    const error = new Error("Your account is not assigned to a hospital or doctor profile");
    error.statusCode = 403;
    throw error;
  }

  if (filters.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(filters.date))) {
      throw badRequest("Date must be YYYY-MM-DD");
    }
    values.push(filters.date);
    clauses.push(`a.appointment_date = $${values.length}`);
  }

  if (filters.hospital) {
    if (!parseId(filters.hospital)) throw badRequest("Invalid hospital filter");
    values.push(parseId(filters.hospital));
    clauses.push(`h.id = $${values.length}`);
  }

  if (filters.doctor) {
    if (!parseId(filters.doctor)) throw badRequest("Invalid doctor filter");
    values.push(parseId(filters.doctor));
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

async function fetchAdminAppointments(filters = {}, user = null) {
  const { values, whereClause } = buildAppointmentFilterQuery(filters, user);
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
            d.max_patients_per_day, d.qualification, d.experience_years, d.consultation_fee,
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

  return canSeeNotes(user)
    ? result.rows
    : result.rows.map((row) => ({ ...row, visit_notes: null }));
}

async function getAdminDashboard(req, res, next) {
  try {
    const [statsResult, bookingsPerDayResult, topDoctorsResult, topHospitalsResult] =
      await Promise.all([
        pool.query(
          `SELECT
             (SELECT COUNT(*) FROM hospitals WHERE is_active)::int AS total_hospitals,
             (SELECT COUNT(*) FROM doctors WHERE is_active)::int AS total_doctors,
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
    await audit(req, "city.create", "city", result.rows[0].id, { name: normalizedName });

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getAdminHospitals(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT h.id, h.name, h.location, h.image, h.city_id, h.contact_phone, h.map_link, h.address, h.description, h.logo, h.email, h.opens_at, h.closes_at,
              h.is_active,
              c.name AS city_name,
              COUNT(d.id) FILTER (WHERE d.is_active)::int AS doctor_count
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
    const scope = scopeOf(req.user);
    if (!scope) return forbidden(res);
    const scopeValues = scope.all ? [] : [scope.hospitalId];
    const result = await pool.query(
      `SELECT d.id, d.name, d.specialization, d.image, d.available_from, d.available_to,
              d.is_active,
              d.slot_step_minutes, d.slot_duration_minutes,
              d.unavailable_days, d.availability_note,
              d.department_id, dep.name AS department_name,
              d.max_patients_per_day, d.qualification, d.experience_years, d.consultation_fee,
              d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              c.name AS city_name
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       JOIN cities c ON c.id = h.city_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       ${scope.all ? "" : "WHERE d.hospital_id = $1"}
       ORDER BY d.name`,
      scopeValues
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
      unavailable_days: unavailableDays,
      availability_note: availabilityNote,
      max_patients_per_day: maxPatientsPerDay,
    } = req.body;
    const normalizedMaxPatients = parsePositiveInt(maxPatientsPerDay, 24);

    if (!name || !specialization || !departmentId || !hospitalId || !req.body.available_from || !req.body.available_to) {
      return res.status(400).json({ error: "All doctor fields are required" });
    }

    if (!normalizedMaxPatients) {
      return res.status(400).json({ error: "Max patients per day must be a positive number" });
    }

    if (!canAccessDoctor(req.user, { id: 0, hospital_id: hospitalId }) && !scopeOf(req.user)?.all) {
      return res.status(403).json({ error: "You can only add doctors to your own hospital" });
    }

    const extras = doctorExtras(req.body);
    const hospital = (
      await pool.query("SELECT id FROM hospitals WHERE id = $1 AND is_active", [hospitalId])
    ).rows[0];
    if (!hospital) {
      return res.status(404).json({ error: "Hospital not found or inactive" });
    }

    const result = await pool.query(
      `INSERT INTO doctors (
         name, specialization, department_id, hospital_id, image, available_from, available_to,
         slot_step_minutes, slot_duration_minutes, unavailable_days, availability_note, max_patients_per_day,
         qualification, experience_years, consultation_fee
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, 0))
       RETURNING *`,
      [
        name,
        specialization,
        departmentId,
        hospitalId,
        extras.image,
        extras.availableFrom,
        extras.availableTo,
        extras.slotStep,
        extras.slotDuration,
        unavailableDays || "",
        availabilityNote || "",
        normalizedMaxPatients,
        extras.qualification,
        extras.experienceYears,
        extras.fee,
      ]
    );
    await audit(req, "doctor.create", "doctor", result.rows[0].id, { name, hospitalId });

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
      unavailable_days: unavailableDays,
      availability_note: availabilityNote,
      max_patients_per_day: maxPatientsPerDay,
    } = req.body;
    const normalizedMaxPatients = parsePositiveInt(maxPatientsPerDay, 24);

    if (!name || !specialization || !departmentId || !hospitalId || !req.body.available_from || !req.body.available_to) {
      return res.status(400).json({ error: "All doctor fields are required" });
    }

    if (!normalizedMaxPatients) {
      return res.status(400).json({ error: "Max patients per day must be a positive number" });
    }

    const targetId = parseId(id);
    if (!targetId) {
      return res.status(400).json({ error: "Invalid doctor id" });
    }
    const current = (
      await pool.query("SELECT id, hospital_id FROM doctors WHERE id = $1", [targetId])
    ).rows[0];
    // Must be allowed on the doctor as it is now AND on the hospital it is being moved to.
    if (
      !current ||
      !canAccessDoctor(req.user, current) ||
      !canAccessDoctor(req.user, { id: current.id, hospital_id: hospitalId })
    ) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const extras = doctorExtras(req.body);
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
           max_patients_per_day = $12,
           qualification = $13,
           experience_years = $14,
           consultation_fee = COALESCE($15, consultation_fee)
       WHERE id = $16
       RETURNING *`,
      [
        name,
        specialization,
        departmentId,
        hospitalId,
        extras.image,
        extras.availableFrom,
        extras.availableTo,
        extras.slotStep,
        extras.slotDuration,
        unavailableDays || "",
        availabilityNote || "",
        normalizedMaxPatients,
        extras.qualification,
        extras.experienceYears,
        extras.fee,
        targetId,
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    await audit(req, "doctor.update", "doctor", targetId, {
      name,
      hospitalId,
      fee: extras.fee,
    });
    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getDoctorLeaves(req, res, next) {
  try {
    const scope = scopeOf(req.user);
    if (!scope) return forbidden(res);
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
       ${scope.all ? "" : scope.doctorId ? "WHERE d.id = $1" : "WHERE d.hospital_id = $1"}
       ORDER BY dl.leave_date DESC, d.name`,
      scope.all ? [] : [scope.doctorId || scope.hospitalId]
    );

    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function addDoctorLeave(req, res, next) {
  try {
    const { doctor_id: rawDoctorId, leave_date: leaveDate, reason } = req.body;
    const doctorId = parseId(rawDoctorId);

    if (!doctorId || !leaveDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(leaveDate))) {
      return res.status(400).json({ error: "Doctor and a valid leave date (YYYY-MM-DD) are required" });
    }

    const leaveDoctor = (
      await pool.query("SELECT id, hospital_id FROM doctors WHERE id = $1", [doctorId])
    ).rows[0];
    if (!leaveDoctor || !canAccessDoctor(req.user, leaveDoctor)) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const result = await pool.query(
      `INSERT INTO doctor_leaves (doctor_id, leave_date, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (doctor_id, leave_date)
       DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id, doctor_id, TO_CHAR(leave_date, 'YYYY-MM-DD') AS leave_date, reason`,
      [doctorId, leaveDate, reason || ""]
    );
    await audit(req, "doctor_leave.set", "doctor", doctorId, { leaveDate });

    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
}

async function deleteDoctorLeave(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const leave = id
      ? (
          await pool.query(
            `SELECT dl.id, d.id AS doctor_id, d.hospital_id
             FROM doctor_leaves dl JOIN doctors d ON d.id = dl.doctor_id
             WHERE dl.id = $1`,
            [id]
          )
        ).rows[0]
      : null;

    if (!leave || !canAccessDoctor(req.user, { id: leave.doctor_id, hospital_id: leave.hospital_id })) {
      return res.status(404).json({ error: "Doctor leave not found" });
    }

    await pool.query("DELETE FROM doctor_leaves WHERE id = $1", [id]);
    await audit(req, "doctor_leave.delete", "doctor", leave.doctor_id, { leaveId: id });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

async function getAdminAppointments(req, res, next) {
  try {
    const appointments = await fetchAdminAppointments(req.query, req.user);
    res.json(appointments);
  } catch (error) {
    next(error);
  }
}

async function exportAdminAppointmentsCsv(req, res, next) {
  try {
    const appointments = await fetchAdminAppointments(req.query, req.user);
    await audit(req, "appointments.export", "appointment", null, { count: appointments.length });
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
      // Prefix formula-trigger characters so spreadsheet apps never execute patient-entered text.
      .map((row) =>
        row
          .map((value) => {
            const text = String(value ?? "");
            const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
            return `"${safe.replace(/"/g, '""')}"`;
          })
          .join(",")
      )
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
    const id = parseId(req.params.id);
    const { status } = req.body;
    const allowedStatuses = ["serving", "completed", "skipped", "booked"];

    if (!id) {
      return res.status(400).json({ error: "Invalid appointment id" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid appointment status" });
    }

    const existing = (
      await pool.query(
        "SELECT id, doctor_id, hospital_id, status FROM appointments WHERE id = $1",
        [id]
      )
    ).rows[0];

    // 404 for both "missing" and "out of scope" so staff cannot probe other hospitals' ids.
    if (!existing || !canAccessAppointment(req.user, existing)) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    if (String(existing.status || "").toLowerCase() === "cancelled") {
      return res.status(409).json({ error: "A cancelled appointment cannot change status" });
    }

    const result = await pool.query(
      `UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status`,
      [status, id]
    );
    await audit(req, "appointment.status", "appointment", id, {
      from: existing.status,
      to: status,
    });

    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function updateAppointmentNotes(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const visitNotes = String(req.body.visit_notes || "").trim();
    if (!id) {
      return res.status(400).json({ error: "Invalid appointment id" });
    }
    if (visitNotes.length > 5000) {
      return res.status(400).json({ error: "Visit notes are limited to 5000 characters" });
    }
    const appointmentResult = await pool.query(
      `SELECT id,
              doctor_id,
              hospital_id,
              status,
              (appointment_date <= CURRENT_DATE) AS notes_allowed
       FROM appointments
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

    const appointment = appointmentResult.rows[0];
    // Clinical notes: only the treating doctor (or a global admin). Others get 404, not 403.
    if (!appointment || !canAccessAppointment(req.user, appointment)) {
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
    await audit(req, "appointment.visit_notes", "appointment", id, { length: visitNotes.length });

    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getTodayBoard(req, res, next) {
  try {
    const scopeClauses = ["d.is_active = TRUE"];
    const scopeValues = [];
    if (!applyAppointmentScope(req.user, scopeClauses, scopeValues, { a: "d", d: "d" })) {
      return forbidden(res);
    }
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
        AND a.appointment_date = CURRENT_DATE AND a.status IS DISTINCT FROM 'pending_payment'
       WHERE ${scopeClauses.join(" AND ")}
       ORDER BY d.name,
                CASE WHEN COALESCE(a.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END,
                a.token_number`,
      scopeValues
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
          visit_notes: canSeeNotes(req.user) ? row.visit_notes : null,
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
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid doctor id" });
    }
    const doctorRow = (
      await pool.query("SELECT id, hospital_id FROM doctors WHERE id = $1", [id])
    ).rows[0];
    // A doctor may only open their own board; hospital staff only their hospital's doctors.
    if (!doctorRow || !canAccessDoctor(req.user, doctorRow)) {
      return res.status(404).json({ error: "Doctor not found" });
    }
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
        AND a.appointment_date = CURRENT_DATE AND a.status IS DISTINCT FROM 'pending_payment'
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
          visit_notes: canSeeNotes(req.user) ? row.visit_notes : null,
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

// Hospitals and doctors are never physically deleted: appointments, visits, prescriptions and
// invoices reference them and must stay readable. "Delete" now means deactivate (reversible).
// A deactivated hospital hides its doctors from booking too; the child rows keep their own flag.
async function setHospitalActive(req, res, next, active) {
  const client = await pool.connect();

  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid hospital id" });
    }
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE hospitals
       SET is_active = $2, deactivated_at = CASE WHEN $2 THEN NULL ELSE NOW() END
       WHERE id = $1
       RETURNING id, is_active`,
      [id, active]
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Hospital not found" });
    }
    const upcoming = await client.query(
      `SELECT COUNT(*)::int AS n FROM appointments
       WHERE hospital_id = $1 AND appointment_date >= CURRENT_DATE
         AND COALESCE(status, 'booked') NOT IN ('cancelled', 'completed')`,
      [id]
    );
    await audit(req, active ? "hospital.reactivate" : "hospital.deactivate", "hospital", id, null, {
      db: client,
      strict: true,
    });
    await client.query("COMMIT");

    return res.json({ success: true, is_active: active, upcoming_appointments: upcoming.rows[0].n });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

async function setDoctorActive(req, res, next, active) {
  const client = await pool.connect();

  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid doctor id" });
    }
    await client.query("BEGIN");
    const current = (
      await client.query("SELECT id, hospital_id FROM doctors WHERE id = $1", [id])
    ).rows[0];
    if (!current || !canAccessDoctor(req.user, current)) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Doctor not found" });
    }
    const result = await client.query(
      `UPDATE doctors
       SET is_active = $2, deactivated_at = CASE WHEN $2 THEN NULL ELSE NOW() END
       WHERE id = $1
       RETURNING id, is_active`,
      [id, active]
    );
    const upcoming = await client.query(
      `SELECT COUNT(*)::int AS n FROM appointments
       WHERE doctor_id = $1 AND appointment_date >= CURRENT_DATE
         AND COALESCE(status, 'booked') NOT IN ('cancelled', 'completed')`,
      [id]
    );
    await audit(req, active ? "doctor.reactivate" : "doctor.deactivate", "doctor", id, null, {
      db: client,
      strict: true,
    });
    await client.query("COMMIT");

    return res.json({
      success: true,
      is_active: result.rows[0].is_active,
      upcoming_appointments: upcoming.rows[0].n,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}

const deleteHospital = (req, res, next) => setHospitalActive(req, res, next, false);
const reactivateHospital = (req, res, next) => setHospitalActive(req, res, next, true);
const deleteDoctor = (req, res, next) => setDoctorActive(req, res, next, false);
const reactivateDoctor = (req, res, next) => setDoctorActive(req, res, next, true);

module.exports = {
  addCity,
  addDoctor,
  addDoctorLeave,
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
  reactivateDoctor,
  reactivateHospital,
  updateAppointmentNotes,
  updateAppointmentStatus,
  updateDoctor,
};
