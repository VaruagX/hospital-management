const pool = require("../config/db");

/**
 * Reusable audit logger.
 *   await audit(req, "doctor.deactivate", "doctor", id, { reason })
 * Pass opts.db (a transaction client) to make the audit row part of the same transaction.
 * By default a failed write is logged but never breaks the request; pass { strict: true }
 * for actions that must not succeed without an audit trail.
 */
async function audit(reqOrUser, action, entity, entityId = null, detail = null, opts = {}) {
  const user = reqOrUser?.user || reqOrUser || null;
  const db = opts.db || pool;
  const text =
    detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 4000);
  try {
    await db.query(
      `INSERT INTO audit_logs (user_id, user_email, action, entity, entity_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user?.id ?? null, user?.email ?? null, action, entity, entityId == null ? null : String(entityId), text]
    );
  } catch (error) {
    if (opts.strict) throw error;
    console.error("Audit log write failed", action, error.message);
  }
}

module.exports = { audit };
