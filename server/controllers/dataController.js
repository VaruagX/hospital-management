const pool = require("../config/db");
const { ACTIVE_QUEUE_STATUSES } = require("../utils/slots");

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
              d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
              CASE WHEN fd.user_id IS NULL THEN FALSE ELSE TRUE END AS is_favorite,
              COALESCE(today.today_bookings, 0)::int AS booked_patients
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       LEFT JOIN favorite_doctors fd ON fd.doctor_id = d.id AND fd.user_id = $2
       LEFT JOIN (
         SELECT doctor_id, COUNT(*) AS today_bookings
         FROM appointments
         WHERE appointment_date = CURRENT_DATE
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
              d.hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
              CASE WHEN fd.user_id IS NULL THEN FALSE ELSE TRUE END AS is_favorite,
              h.city_id, c.name AS city_name,
              COALESCE(today.today_bookings, 0)::int AS booked_patients
       FROM doctors d
       JOIN hospitals h ON h.id = d.hospital_id
       JOIN cities c ON c.id = h.city_id
       LEFT JOIN favorite_doctors fd ON fd.doctor_id = d.id AND fd.user_id = $${index++}
       LEFT JOIN (
         SELECT doctor_id, COUNT(*) AS today_bookings
         FROM appointments
         WHERE appointment_date = CURRENT_DATE
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
              d.id AS doctor_id, d.name AS doctor_name, d.specialization,
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
                  AND COALESCE(prior.slot_number, prior.token_number) < COALESCE(a.slot_number, a.token_number)
              ) AS patients_before
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN hospitals h ON h.id = a.hospital_id
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
              d.id AS doctor_id, d.name AS doctor_name, d.specialization,
              d.available_from, d.available_to, d.slot_step_minutes, d.slot_duration_minutes,
              h.id AS hospital_id, h.name AS hospital_name, h.location AS hospital_location,
              h.contact_phone AS hospital_contact_phone, h.map_link AS hospital_map_link,
              fm.id AS family_member_id, fm.name AS family_member_name, fm.relation AS family_relation
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN hospitals h ON h.id = a.hospital_id
       LEFT JOIN family_members fm ON fm.id = a.family_member_id
       WHERE a.user_id = $1
       ORDER BY a.appointment_date DESC, a.token_number DESC`,
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
         SELECT token_number, status
         FROM appointments
         WHERE doctor_id = $1 AND appointment_date = $2
       ),
       current AS (
         SELECT MIN(token_number) AS current_serving_token
         FROM queue
         WHERE COALESCE(status, 'booked') = ANY($4)
       )
       SELECT
         current.current_serving_token::int,
         COALESCE((SELECT COUNT(*) FROM queue), 0)::int AS total_tokens,
         COALESCE((SELECT COUNT(*) FROM queue WHERE COALESCE(status, 'booked') = ANY($4)), 0)::int AS waiting_patients,
         COALESCE(
           (
             SELECT COUNT(*)
             FROM queue, current
             WHERE $3::int IS NOT NULL
               AND queue.token_number > COALESCE(current.current_serving_token, 0)
               AND queue.token_number < $3::int
               AND COALESCE(queue.status, 'booked') = ANY($4)
           ),
           0
         )::int AS remaining_before_user
       FROM current`,
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
  getHospitalsByCity,
  getDoctorsByHospital,
  getDoctorDirectory,
  getAppointmentDetails,
  getMyAppointments,
  getQueueStatus,
};
