-- 002: Soft deactivation for hospitals/doctors (replaces permanent deletes) + RBAC support. Additive.
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT TRUE;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS deactivated_at timestamp;
ALTER TABLE doctors   ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT TRUE;
ALTER TABLE doctors   ADD COLUMN IF NOT EXISTS deactivated_at timestamp;
CREATE INDEX IF NOT EXISTS idx_users_hospital ON users (hospital_id) WHERE hospital_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_doctor   ON users (doctor_id)   WHERE doctor_id   IS NOT NULL;
-- A doctor account maps to at most one doctor profile and vice-versa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_doctor_id ON users (doctor_id) WHERE doctor_id IS NOT NULL;
-- Roles are validated by the application (patient, admin, hospital_admin, doctor, receptionist);
-- no CHECK is added so existing rows can never be rejected.
