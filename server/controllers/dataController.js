const pool = require("../config/db");
const { ACTIVE_QUEUE_STATUSES } = require("../utils/slots");
const PRIORITY_SORT_SQL = `CASE WHEN COALESCE(a.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END`;
const DOCTOR_PRIORITY_SORT_SQL = `CASE WHEN COALESCE(priority, 'normal') = 'emergency' THEN 0 ELSE 1 END`;

function normalizePhone(phone) {
  return String(phone || "").trim();
}

function isValidPhone(phone) {
  const normalized = normalizePhone(phone);
  return !normalized || /^[0-9+\-\s()]{7,20}$/.test(normalized);
}

async function getCities(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, COUNT(h.id)::int AS hospital_count
       FROM cities c
       LEFT JOIN hospitals h ON h.city_id = c.id
       GROUP BY c.id
       ORDER BY c.name`
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function getHospitalsByCity(req, res, next) {
  try {
    const { cityId } = req.params;
    const result = await pool.query(
      `SELECT h.id, h.name, h.location, h.image, h.city_id, h.contact_phone, h.map_link,
              c.name AS city_name,
              CASE WHEN fh.user_id IS NULL THEN FALSE ELSE TRUE END AS is_favorite,
              COUNT(d.id)::int AS doctor_count
       FROM hospitals h
       JOIN cities c ON c.id = h.city_id
       LEFT JOIN favorite_hospitals fh ON fh.hospital_id = h.id AND fh.user_id = $2
       LEFT JOIN doctors d ON d.hospital_id = h.id
       WHERE h.city_id = $1
       GROUP BY h.id, c.name, fh.user_id
       ORDER BY h.name`,
      [cityId, req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function getDoctorsByHospital(req, res, next) {
  try {
    const { hospitalId } = req.params;
    const result = await pool.query(
      `SELECT d.id, d.name, d.specialization, d.image, d.available_from, d.available_to,
              d.slot_step_minutes, d.slot_duration_minutes,
              d.unavailable_days, d.availability_note,
              d.department_id, dep.name AS department_name,
              d.max_patients_per_day,
              d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
              CASE WHEN fd.user_id IS NULL THEN FALSE ELSE TRUE END AS is_favorite,
              COALESCE(today.today_bookings, 0)::int AS booked_patients
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN favorite_doctors fd ON fd.doctor_id = d.id AND fd.user_id = $2
       LEFT JOIN (
         SELECT doctor_id, COUNT(*) AS today_bookings
         FROM appointments
         WHERE appointment_date = CURRENT_DATE
           AND COALESCE(status, 'booked') <> 'cancelled'
         GROUP BY doctor_id
       ) today ON today.doctor_id = d.id
       WHERE d.hospital_id = $1
       ORDER BY d.name`,
      [hospitalId, req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function getDoctorDirectory(req, res, next) {
  try {
    const {
      cityId,
      hospitalId,
      departmentId,
      specialization,
      day,
      search,
    } = req.query;

    const filters = [];
    const values = [];
    let index = 1;

    if (cityId) {
      filters.push(`h.city_id = $${index++}`);
      values.push(cityId);
    }
    if (hospitalId) {
      filters.push(`d.hospital_id = $${index++}`);
      values.push(hospitalId);
    }
    if (departmentId) {
      filters.push(`d.department_id = $${index++}`);
      values.push(departmentId);
    }
    if (specialization) {
      filters.push(`LOWER(d.specialization) = LOWER($${index++})`);
      values.push(specialization);
    }
    if (day) {
      filters.push(`POSITION(LOWER($${index++}) IN LOWER(COALESCE(d.unavailable_days, ''))) = 0`);
      values.push(day);
    }
    if (search) {
      filters.push(`(
        LOWER(d.name) LIKE LOWER($${index})
        OR LOWER(d.specialization) LIKE LOWER($${index})
        OR LOWER(h.name) LIKE LOWER($${index})
      )`);
      values.push(`%${search}%`);
      index += 1;
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT d.id, d.name, d.specialization, d.image, d.available_from, d.available_to,
              d.slot_step_minutes, d.slot_duration_minutes,
              d.unavailable_days, d.availability_note,
              d.department_id, dep.name AS department_name,
              d.max_patients_per_day,
              d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
              CASE WHEN fd.user_id IS NULL THEN FALSE ELSE TRUE END AS is_favorite,
              h.city_id, c.name AS city_name,
              COALESCE(today.today_bookings, 0)::int AS booked_patients
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       JOIN cities c ON c.id = h.city_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN favorite_doctors fd ON fd.doctor_id = d.id AND fd.user_id = $${index++}
       LEFT JOIN (
         SELECT doctor_id, COUNT(*) AS today_bookings
         FROM appointments
         WHERE appointment_date = CURRENT_DATE
           AND COALESCE(status, 'booked') <> 'cancelled'
         GROUP BY doctor_id
       ) today ON today.doctor_id = d.id
       ${whereClause}
       ORDER BY c.name, h.name, d.name`,
      [...values, req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

async function getHospitalDetails(req, res, next) {
  try {
    const { hospitalId } = req.params;
    const [hospitalResult, doctorsResult] = await Promise.all([
      pool.query(
        `SELECT h.id, h.name, h.location, h.image, h.city_id, h.contact_phone, h.map_link,
                c.name AS city_name,
                CASE WHEN fh.user_id IS NULL THEN FALSE ELSE TRUE END AS is_favorite,
                COUNT(d.id)::int AS doctor_count
         FROM hospitals h
         JOIN cities c ON c.id = h.city_id
         LEFT JOIN favorite_hospitals fh ON fh.hospital_id = h.id AND fh.user_id = $2
         LEFT JOIN doctors d ON d.hospital_id = h.id
         WHERE h.id = $1
         GROUP BY h.id, c.name, fh.user_id
         LIMIT 1`,
        [hospitalId, req.user.id]
      ),
      pool.query(
        `SELECT d.id, d.name, d.specialization, d.image, d.available_from, d.available_to,
                d.slot_step_minutes, d.slot_duration_minutes,
                d.unavailable_days, d.availability_note,
                d.department_id, dep.name AS department_name,
                d.max_patients_per_day,
                d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
                h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
                c.name AS city_name,
                CASE WHEN fd.user_id IS NULL THEN FALSE ELSE TRUE END AS is_favorite,
                COALESCE(today.today_bookings, 0)::int AS booked_patients
         FROM doctors d
         JOIN hospitals h ON h.id = d.hospital_id
         JOIN cities c ON c.id = h.city_id
         LEFT JOIN departments dep ON dep.id = d.department_id
         LEFT JOIN favorite_doctors fd ON fd.doctor_id = d.id AND fd.user_id = $2
         LEFT JOIN (
           SELECT doctor_id, COUNT(*) AS today_bookings
           FROM appointments
           WHERE appointment_date = CURRENT_DATE
             AND COALESCE(status, 'booked') <> 'cancelled'
           GROUP BY doctor_id
         ) today ON today.doctor_id = d.id
         WHERE d.hospital_id = $1
         ORDER BY d.name`,
        [hospitalId, req.user.id]
      ),
    ]);

    const hospital = hospitalResult.rows[0];
    if (!hospital) {
      return res.status(404).json({ error: "Hospital not found" });
    }

    return res.json({
      ...hospital,
      doctors: doctorsResult.rows,
    });
  } catch (error) {
    return next(error);
  }
}

async function getDoctorDetails(req, res, next) {
  try {
    const { doctorId } = req.params;
    const result = await pool.query(
      `SELECT d.id, d.name, d.specialization, d.image, d.available_from, d.available_to,
              d.slot_step_minutes, d.slot_duration_minutes,
              d.unavailable_days, d.availability_note,
              d.department_id, dep.name AS department_name,
              d.max_patients_per_day,
              d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
              h.city_id, c.name AS city_name,
              CASE WHEN fd.user_id IS NULL THEN FALSE ELSE TRUE END AS is_favorite,
              COALESCE(stats.today_bookings, 0)::int AS booked_patients,
              COALESCE(stats.total_bookings, 0)::int AS total_bookings,
              COALESCE(stats.completed_bookings, 0)::int AS completed_bookings,
              COALESCE(stats.upcoming_bookings, 0)::int AS upcoming_bookings,
              COALESCE(stats.cancelled_bookings, 0)::int AS cancelled_bookings
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       JOIN cities c ON c.id = h.city_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN favorite_doctors fd ON fd.doctor_id = d.id AND fd.user_id = $2
       LEFT JOIN (
         SELECT doctor_id,
                COUNT(*) FILTER (WHERE COALESCE(status, 'booked') <> 'cancelled') AS total_bookings,
                COUNT(*) FILTER (WHERE appointment_date = CURRENT_DATE AND COALESCE(status, 'booked') <> 'cancelled') AS today_bookings,
                COUNT(*) FILTER (WHERE COALESCE(status, 'booked') = 'completed') AS completed_bookings,
                COUNT(*) FILTER (
                  WHERE appointment_date >= CURRENT_DATE
                    AND COALESCE(status, 'booked') NOT IN ('completed', 'cancelled', 'skipped')
                ) AS upcoming_bookings,
                COUNT(*) FILTER (WHERE COALESCE(status, 'booked') = 'cancelled') AS cancelled_bookings
         FROM appointments
         GROUP BY doctor_id
       ) stats ON stats.doctor_id = d.id
       WHERE d.id = $1
       LIMIT 1`,
      [doctorId, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getProfile(req, res, next) {
  try {
    const [userResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT id, name, email, photo, role, phone
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [req.user.id]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total_appointments,
                COUNT(*) FILTER (
                  WHERE appointment_date >= CURRENT_DATE
                    AND COALESCE(status, 'booked') NOT IN ('completed', 'cancelled', 'skipped')
                )::int AS upcoming_appointments,
                COUNT(*) FILTER (WHERE COALESCE(status, 'booked') = 'completed')::int AS completed_appointments,
                COUNT(*) FILTER (WHERE COALESCE(status, 'booked') = 'cancelled')::int AS cancelled_appointments
         FROM appointments
         WHERE user_id = $1`,
        [req.user.id]
      ),
    ]);

    return res.json({
      user: userResult.rows[0] || null,
      stats: statsResult.rows[0] || {
        total_appointments: 0,
        upcoming_appointments: 0,
        completed_appointments: 0,
        cancelled_appointments: 0,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function updateProfile(req, res, next) {
  try {
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "Enter a valid phone number" });
    }

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           phone = $2
       WHERE id = $3
       RETURNING id, name, email, photo, role, phone`,
      [name, phone || null, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
}

async function getNotifications(req, res, next) {
  try {
    const [notificationsResult, unreadResult] = await Promise.all([
      pool.query(
        `SELECT id,
                appointment_id,
                type,
                title,
                message,
                TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
                read_at IS NOT NULL AS is_read
         FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 40`,
        [req.user.id]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS unread_count
         FROM notifications
         WHERE user_id = $1
           AND read_at IS NULL`,
        [req.user.id]
      ),
    ]);

    return res.json({
      items: notificationsResult.rows,
      unreadCount: unreadResult.rows[0]?.unread_count || 0,
    });
  } catch (error) {
    return next(error);
  }
}

async function markNotificationsRead(req, res, next) {
  try {
    await pool.query(
      `UPDATE notifications
       SET read_at = NOW()
       WHERE user_id = $1
         AND read_at IS NULL`,
      [req.user.id]
    );

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
}

async function getAppointmentDetails(req, res, next) {
  try {
    const { appointmentId } = req.params;
    const result = await pool.query(
      `SELECT a.id, a.user_name, a.mobile,
              TO_CHAR(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
              a.token_number, COALESCE(a.slot_number, a.token_number)::int AS slot_number,
              TO_CHAR(a.slot_start, 'HH24:MI') AS slot_start,
              TO_CHAR(a.slot_end, 'HH24:MI') AS slot_end,
              a.status,
              COALESCE(a.priority, 'normal') AS priority,
              a.reason_for_visit,
              a.visit_notes,
              d.id AS doctor_id, d.name AS doctor_name, d.specialization,
              d.department_id, dep.name AS department_name,
              d.max_patients_per_day,
              d.available_from, d.available_to, d.slot_step_minutes, d.slot_duration_minutes,
              h.id AS hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
              fm.id AS family_member_id, fm.name AS family_member_name, fm.relation AS family_relation,
              (
                SELECT COUNT(*)::int
                FROM appointments prior
                WHERE prior.doctor_id = a.doctor_id
                  AND prior.appointment_date = a.appointment_date
                  AND COALESCE(prior.status, 'booked') <> 'cancelled'
                  AND (
                    CASE WHEN COALESCE(prior.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END <
                      CASE WHEN COALESCE(a.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END
                    OR (
                      CASE WHEN COALESCE(prior.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END =
                        CASE WHEN COALESCE(a.priority, 'normal') = 'emergency' THEN 0 ELSE 1 END
                      AND COALESCE(prior.token_number, 0) < COALESCE(a.token_number, 0)
                    )
                  )
              ) AS patients_before
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN hospitals h ON h.id = a.hospital_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN family_members fm ON fm.id = a.family_member_id
       WHERE a.id = $1 AND a.user_id = $2`,
      [appointmentId, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getMyAppointments(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT a.id, a.user_name, a.mobile,
              TO_CHAR(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
              a.token_number, COALESCE(a.slot_number, a.token_number)::int AS slot_number,
              TO_CHAR(a.slot_start, 'HH24:MI') AS slot_start,
              TO_CHAR(a.slot_end, 'HH24:MI') AS slot_end,
              a.status,
              COALESCE(a.priority, 'normal') AS priority,
              a.reason_for_visit,
              a.visit_notes,
              d.id AS doctor_id, d.name AS doctor_name, d.specialization,
              d.department_id, dep.name AS department_name,
              d.max_patients_per_day,
              d.available_from, d.available_to, d.slot_step_minutes, d.slot_duration_minutes,
              h.id AS hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
              fm.id AS family_member_id, fm.name AS family_member_name, fm.relation AS family_relation
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN hospitals h ON h.id = a.hospital_id
       LEFT JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN family_members fm ON fm.id = a.family_member_id
       WHERE a.user_id = $1
       ORDER BY a.appointment_date DESC,
                ${PRIORITY_SORT_SQL},
                a.token_number ASC`,
      [req.user.id]
    );

    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .split("T")[0];
    res.json({
      upcoming: result.rows.filter(
        (appointment) =>
          appointment.appointment_date >= today &&
          !["completed", "cancelled", "skipped"].includes((appointment.status || "").toLowerCase())
      ),
      past: result.rows.filter(
        (appointment) =>
          appointment.appointment_date < today ||
          ["completed", "cancelled", "skipped"].includes((appointment.status || "").toLowerCase())
      ),
    });
  } catch (error) {
    next(error);
  }
}

async function getQueueStatus(req, res, next) {
  try {
    const { doctorId, date } = req.params;
    const normalizedDate = String(date).split("T")[0];
    const token = req.query.token ? Number(req.query.token) : null;

    const queueResult = await pool.query(
      `WITH queue AS (
         SELECT token_number,
                COALESCE(priority, 'normal') AS priority,
                COALESCE(status, 'booked') AS status,
                ROW_NUMBER() OVER (
                  ORDER BY ${DOCTOR_PRIORITY_SORT_SQL}, token_number
                ) AS queue_position
         FROM appointments
         WHERE doctor_id = $1
           AND appointment_date = $2
           AND COALESCE(status, 'booked') <> 'cancelled'
       ),
       current AS (
         SELECT token_number, queue_position
         FROM queue
         WHERE status = ANY($4)
         ORDER BY queue_position
         LIMIT 1
       ),
       user_row AS (
         SELECT token_number, queue_position
         FROM queue
         WHERE token_number = $3
         LIMIT 1
       )
       SELECT
         current.token_number::int AS current_serving_token,
         COALESCE((SELECT COUNT(*) FROM queue), 0)::int AS total_tokens,
         COALESCE((SELECT COUNT(*) FROM queue WHERE status = ANY($4)), 0)::int AS waiting_patients,
         CASE
           WHEN (SELECT queue_position FROM user_row) IS NULL THEN 0
           WHEN (SELECT queue_position FROM current) IS NULL THEN
             GREATEST((SELECT queue_position FROM user_row) - 1, 0)
           ELSE
             GREATEST(
               (SELECT queue_position FROM user_row) - (SELECT queue_position FROM current) - 1,
               0
             )
         END::int AS remaining_before_user
       FROM (SELECT 1) AS seed
       LEFT JOIN current ON TRUE`,
      [doctorId, normalizedDate, token, ACTIVE_QUEUE_STATUSES]
    );

    res.json({
      currentServingToken: queueResult.rows[0]?.current_serving_token || null,
      userToken: token,
      remainingPatients: queueResult.rows[0]?.remaining_before_user || 0,
      totalTokens: queueResult.rows[0]?.total_tokens || 0,
      waitingPatients: queueResult.rows[0]?.waiting_patients || 0,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getCities,
  getDoctorDetails,
  getHospitalsByCity,
  getDoctorsByHospital,
  getDoctorDirectory,
  getHospitalDetails,
  getAppointmentDetails,
  getMyAppointments,
  getNotifications,
  getProfile,
  getQueueStatus,
  markNotificationsRead,
  updateProfile,
};
