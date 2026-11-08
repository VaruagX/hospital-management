// Patient records: self-service for the managing account, scoped read access for staff.
const pool = require("../config/db");
const { audit } = require("../services/audit");
const { cleanInput, resolvePatient } = require("../services/patients");
const { roleOf } = require("../middleware/auth");
const { scopeOf } = require("../policies/access");
const { parseId } = require("../utils/validate");

const OWN_FIELDS = `p.id, p.mrn, p.full_name, p.date_of_birth, p.gender, p.blood_group, p.phone, p.email,
  p.address, p.emergency_contact_name, p.emergency_contact_phone, p.allergies, p.chronic_conditions,
  p.medical_history, p.relation, p.family_member_id, p.created_at`;

function pageParams(query) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 25, 1), 100);
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

const APPOINTMENT_HISTORY_SQL = `
  SELECT a.id, TO_CHAR(a.appointment_date,'YYYY-MM-DD') AS appointment_date,
         TO_CHAR(a.slot_start,'HH24:MI') AS slot_start, TO_CHAR(a.slot_end,'HH24:MI') AS slot_end,
         a.token_number, a.status, a.fee_amount, a.reason_for_visit,
         d.name AS doctor_name, d.specialization, h.name AS hospital_name, c.name AS city_name,
         pay.status AS payment_status, r.receipt_no
  FROM appointments a
  JOIN doctors d ON d.id = a.doctor_id
  JOIN hospitals h ON h.id = a.hospital_id
  JOIN cities c ON c.id = h.city_id
  LEFT JOIN LATERAL (SELECT status FROM appointment_payments WHERE appointment_id = a.id ORDER BY id DESC LIMIT 1) pay ON TRUE
  LEFT JOIN receipts r ON r.appointment_id = a.id`;

async function listMyPatients(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT ${OWN_FIELDS} FROM patients p WHERE p.user_id = $1 AND p.deleted_at IS NULL ORDER BY p.relation <> 'self', p.full_name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
}

async function createPatient(req, res, next) {
  try {
    const { patient, created } = await resolvePatient(pool, req.user.id, req.body, {
      relation: String(req.body.relation || "self").slice(0, 30),
    });
    if (!created) {
      return res.status(409).json({ error: "A patient record with this name already exists", patient });
    }
    await audit(req, "patient.create", "patient", patient.id, { mrn: patient.mrn });
    return res.status(201).json(patient);
  } catch (error) {
    return next(error);
  }
}

async function getMyPatient(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const row = id
      ? (await pool.query(`SELECT ${OWN_FIELDS} FROM patients p WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL`, [id, req.user.id])).rows[0]
      : null;
    if (!row) return res.status(404).json({ error: "Patient record not found" });
    return res.json(row);
  } catch (error) {
    return next(error);
  }
}

async function updateMyPatient(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const data = cleanInput(req.body);
    if (!id) return res.status(404).json({ error: "Patient record not found" });
    if (req.body.full_name !== undefined && !data.full_name) {
      return res.status(400).json({ error: "Name cannot be empty" });
    }
    // Only supplied fields change; name/DOB changes are re-checked against the uniqueness rule by the DB.
    const sets = [];
    const values = [id, req.user.id];
    for (const [key, value] of Object.entries(data)) {
      if (req.body[key] !== undefined || (key === "full_name" && req.body.name !== undefined) ||
          (key === "date_of_birth" && req.body.dob !== undefined) || (key === "phone" && req.body.mobile !== undefined)) {
        values.push(value);
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    const result = await pool.query(
      `UPDATE patients p SET ${sets.join(", ")}, updated_at = NOW()
       WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL RETURNING ${OWN_FIELDS}`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Patient record not found" });
    await audit(req, "patient.update", "patient", id, { fields: sets.length });
    return res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Another patient record with this name and date of birth already exists" });
    }
    return next(error);
  }
}

async function myPatientHistory(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const owned = id
      ? (await pool.query("SELECT 1 FROM patients WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL", [id, req.user.id])).rows[0]
      : null;
    if (!owned) return res.status(404).json({ error: "Patient record not found" });
    const { rows } = await pool.query(
      `${APPOINTMENT_HISTORY_SQL} WHERE a.patient_id = $1 ORDER BY a.appointment_date DESC, a.slot_start DESC NULLS LAST`,
      [id]
    );
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------- staff (scoped)
/** SQL predicate limiting patients to those the staff user has an appointment relationship with. */
function staffPatientScope(user, values) {
  const scope = scopeOf(user);
  if (!scope) return null;
  if (scope.all) return "TRUE";
  values.push(scope.doctorId || scope.hospitalId);
  const col = scope.doctorId ? "a2.doctor_id" : "a2.hospital_id";
  return `EXISTS (SELECT 1 FROM appointments a2 WHERE a2.patient_id = p.id AND ${col} = $${values.length}
                  AND a2.status IS DISTINCT FROM 'pending_payment')`;
}

async function staffListPatients(req, res, next) {
  try {
    const { limit, page, offset } = pageParams(req.query);
    const values = [];
    const scopeSql = staffPatientScope(req.user, values);
    if (!scopeSql) return res.status(403).json({ error: "Your account is not assigned to a hospital or doctor profile" });
    const clauses = ["p.deleted_at IS NULL", scopeSql];
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q) {
      values.push(`%${q}%`);
      clauses.push(`(lower(p.full_name) LIKE $${values.length} OR p.phone LIKE $${values.length} OR lower(p.mrn) LIKE $${values.length})`);
    }
    const where = clauses.join(" AND ");
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT p.id, p.mrn, p.full_name, p.date_of_birth, p.gender, p.phone, p.email, p.created_at,
                (SELECT COUNT(*)::int FROM appointments a WHERE a.patient_id = p.id) AS appointment_count
         FROM patients p WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}`,
        values
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM patients p WHERE ${where}`, values),
    ]);
    return res.json({ page, limit, total: total.rows[0].n, items: rows.rows });
  } catch (error) {
    return next(error);
  }
}

async function staffGetPatient(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const values = [id || 0];
    const scopeSql = staffPatientScope(req.user, values);
    if (!scopeSql) return res.status(403).json({ error: "Your account is not assigned to a hospital or doctor profile" });
    const patient = (
      await pool.query(`SELECT ${OWN_FIELDS} FROM patients p WHERE p.id = $1 AND p.deleted_at IS NULL AND ${scopeSql}`, values)
    ).rows[0];
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    // Medical details are clinical data: treating doctors and global admins only.
    const clinical = roleOf(req.user) === "admin" || roleOf(req.user) === "doctor";
    if (!clinical) {
      patient.allergies = patient.chronic_conditions = patient.medical_history = null;
    }
    // Staff see only the appointments inside their own scope (their doctor / their hospital).
    const scope = scopeOf(req.user);
    const historyValues = [id];
    let scopeClause = "";
    if (!scope.all) {
      historyValues.push(scope.doctorId || scope.hospitalId);
      scopeClause = `AND ${scope.doctorId ? "a.doctor_id" : "a.hospital_id"} = $2`;
    }
    const history = (
      await pool.query(
        `${APPOINTMENT_HISTORY_SQL} WHERE a.patient_id = $1 AND a.status IS DISTINCT FROM 'pending_payment' ${scopeClause}
         ORDER BY a.appointment_date DESC`,
        historyValues
      )
    ).rows;
    await audit(req, "patient.view", "patient", id);
    return res.json({ ...patient, appointments: history });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createPatient, getMyPatient, listMyPatients, myPatientHistory,
  staffGetPatient, staffListPatients, updateMyPatient,
};
