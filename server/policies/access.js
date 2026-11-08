// Resource-level access rules. Role checks live in middleware; these decide WHICH records a role may touch.
const { roleOf } = require("../middleware/auth");

/**
 * Data scope for a staff user, or null when they have no valid scope (caller must 403).
 *  admin                          -> { all: true }
 *  hospital_admin / receptionist  -> { hospitalId }  (must be assigned to a hospital)
 *  doctor                         -> { doctorId }    (must be linked to a doctor profile)
 */
function scopeOf(user) {
  const role = roleOf(user);
  if (role === "admin") return { role, all: true };
  if (role === "hospital_admin" || role === "receptionist") {
    return user.hospital_id ? { role, hospitalId: user.hospital_id } : null;
  }
  if (role === "doctor") {
    return user.doctor_id ? { role, doctorId: user.doctor_id } : null;
  }
  return null;
}

/**
 * Appends scope predicates for appointment queries (a = appointments alias, d = doctors alias).
 * Mutates clauses/values. Returns false when the user has no scope.
 */
function applyAppointmentScope(user, clauses, values, { a = "a", d = "d" } = {}) {
  const scope = scopeOf(user);
  if (!scope) return false;
  if (scope.all) return true;
  if (scope.doctorId) {
    values.push(scope.doctorId);
    clauses.push(`${d}.id = $${values.length}`);
  } else {
    values.push(scope.hospitalId);
    clauses.push(`${a}.hospital_id = $${values.length}`);
  }
  return true;
}

/** Can this user act on a doctor profile ({id, hospital_id})? */
function canAccessDoctor(user, doctor) {
  const scope = scopeOf(user);
  if (!scope || !doctor) return false;
  if (scope.all) return true;
  if (scope.doctorId) return Number(doctor.id) === Number(scope.doctorId);
  return Number(doctor.hospital_id) === Number(scope.hospitalId);
}

/** Can this user act on an appointment row ({doctor_id, hospital_id})? */
function canAccessAppointment(user, appt) {
  const scope = scopeOf(user);
  if (!scope || !appt) return false;
  if (scope.all) return true;
  if (scope.doctorId) return Number(appt.doctor_id) === Number(scope.doctorId);
  return Number(appt.hospital_id) === Number(scope.hospitalId);
}

module.exports = { scopeOf, applyAppointmentScope, canAccessDoctor, canAccessAppointment };
