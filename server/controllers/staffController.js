const pool = require("../config/db");
const { isAdminEmail } = require("../config/runtime");
const { audit } = require("../services/audit");

// "admin" is intentionally not assignable here: global admins come only from ADMIN_EMAIL.
const ASSIGNABLE_ROLES = ["patient", "receptionist", "doctor", "hospital_admin"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function pageParams(query) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 25, 1), 100);
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}

async function listStaff(req, res, next) {
  try {
    const { limit, offset, page } = pageParams(req.query);
    const search = String(req.query.q || "").trim();
    const values = [];
    const clauses = ["(u.role <> 'patient' OR u.hospital_id IS NOT NULL OR u.doctor_id IS NOT NULL)"];
    if (search) {
      values.push(`%${search.toLowerCase()}%`);
      clauses.push(`(LOWER(u.email) LIKE $${values.length} OR LOWER(COALESCE(u.name,'')) LIKE $${values.length})`);
    }
    const where = clauses.join(" AND ");
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.is_active, u.hospital_id, u.doctor_id,
                h.name AS hospital_name, d.name AS doctor_name
         FROM users u
         LEFT JOIN hospitals h ON h.id = u.hospital_id
         LEFT JOIN doctors d ON d.id = u.doctor_id
         WHERE ${where}
         ORDER BY u.role, u.email
         LIMIT ${limit} OFFSET ${offset}`,
        values
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM users u WHERE ${where}`, values),
    ]);
    res.json({ page, limit, total: total.rows[0].n, items: rows.rows });
  } catch (error) {
    next(error);
  }
}

/**
 * Create or update a staff account by email. If the person has not signed in yet the row is
 * pre-created; Google sign-in later matches on email and keeps the assigned role (see syncUser).
 */
async function upsertStaff(req, res, next) {
  const client = await pool.connect();
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "").toLowerCase();
    const hospitalIdInput = req.body.hospital_id ? parseId(req.body.hospital_id) : null;
    const doctorIdInput = req.body.doctor_id ? parseId(req.body.doctor_id) : null;

    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}` });
    }
    if (isAdminEmail(email)) {
      return res.status(403).json({ error: "The configured administrator account cannot be modified here" });
    }

    let hospitalId = null;
    let doctorId = null;
    await client.query("BEGIN");

    if (role === "doctor") {
      if (!doctorIdInput) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "doctor_id is required for the doctor role" });
      }
      const doctor = (
        await client.query("SELECT id, hospital_id FROM doctors WHERE id = $1", [doctorIdInput])
      ).rows[0];
      if (!doctor) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Doctor not found" });
      }
      doctorId = doctor.id;
      hospitalId = doctor.hospital_id;
    } else if (role === "hospital_admin" || role === "receptionist") {
      if (!hospitalIdInput) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "hospital_id is required for this role" });
      }
      const hospital = (
        await client.query("SELECT id FROM hospitals WHERE id = $1", [hospitalIdInput])
      ).rows[0];
      if (!hospital) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Hospital not found" });
      }
      hospitalId = hospital.id;
    }

    const previous = (
      await client.query("SELECT id, role FROM users WHERE LOWER(email) = $1", [email])
    ).rows[0];

    let user;
    try {
      user = (
        await client.query(
          `INSERT INTO users (email, name, role, hospital_id, doctor_id, is_active)
           VALUES ($1, $2, $3, $4, $5, TRUE)
           ON CONFLICT (email) DO UPDATE
             SET role = EXCLUDED.role,
                 hospital_id = EXCLUDED.hospital_id,
                 doctor_id = EXCLUDED.doctor_id,
                 name = COALESCE(users.name, EXCLUDED.name)
           RETURNING id, email, name, role, hospital_id, doctor_id, is_active`,
          [email, req.body.name ? String(req.body.name).trim().slice(0, 120) : null, role, hospitalId, doctorId]
        )
      ).rows[0];
    } catch (error) {
      if (error.code === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "That doctor profile is already linked to another account" });
      }
      throw error;
    }

    await audit(req, "staff.assign", "user", user.id, { email, from: previous?.role || null, to: role, hospitalId, doctorId }, {
      db: client,
      strict: true,
    });
    await client.query("COMMIT");
    return res.status(previous ? 200 : 201).json(user);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
}

async function setStaffActive(req, res, next, active) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid user id" });
    const target = (await pool.query("SELECT id, email FROM users WHERE id = $1", [id])).rows[0];
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!active && (isAdminEmail(target.email) || target.id === req.user.id)) {
      return res.status(403).json({ error: "You cannot deactivate this account" });
    }
    await pool.query("UPDATE users SET is_active = $2 WHERE id = $1", [id, active]);
    await audit(req, active ? "staff.reactivate" : "staff.deactivate", "user", id, { email: target.email });
    return res.json({ success: true, is_active: active });
  } catch (error) {
    return next(error);
  }
}

async function listAuditLogs(req, res, next) {
  try {
    const { limit, offset, page } = pageParams(req.query);
    const values = [];
    const clauses = [];
    for (const key of ["entity", "action"]) {
      if (req.query[key]) {
        values.push(String(req.query[key]).slice(0, 80));
        clauses.push(`${key} = $${values.length}`);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT id, user_id, user_email, action, entity, entity_id, detail, created_at
         FROM audit_logs ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
        values
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs ${where}`, values),
    ]);
    res.json({ page, limit, total: total.rows[0].n, items: rows.rows });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listAuditLogs,
  listStaff,
  upsertStaff,
  deactivateStaff: (req, res, next) => setStaffActive(req, res, next, false),
  reactivateStaff: (req, res, next) => setStaffActive(req, res, next, true),
};
