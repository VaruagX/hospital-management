-- 000: Baseline = the pre-HMS schema, previously created by hand + server/config/schema.js.
-- All IF NOT EXISTS: a no-op on the live Neon database, builds a fresh DB (tests/dev) from scratch.
-- Deliberately contains NO data rewrites (the old startup backfills are not reproduced).
CREATE TABLE IF NOT EXISTS cities (id serial PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY, name text, email text NOT NULL UNIQUE, photo text,
  role text DEFAULT 'patient', created_at timestamp DEFAULT CURRENT_TIMESTAMP, phone text);
CREATE TABLE IF NOT EXISTS hospitals (
  id serial PRIMARY KEY, name text NOT NULL, city_id integer REFERENCES cities(id), location text, image text,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP, contact_phone text DEFAULT '', map_link text DEFAULT '');
CREATE TABLE IF NOT EXISTS departments (
  id serial PRIMARY KEY, name text NOT NULL UNIQUE, created_at timestamp NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS doctors (
  id serial PRIMARY KEY, name text NOT NULL, specialization text,
  hospital_id integer REFERENCES hospitals(id), image text,
  available_from time, available_to time, created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  unavailable_days text DEFAULT '', availability_note text DEFAULT '',
  slot_step_minutes integer DEFAULT 15, slot_duration_minutes integer DEFAULT 15,
  department_id integer REFERENCES departments(id) ON DELETE SET NULL,
  max_patients_per_day integer DEFAULT 24 CHECK (max_patients_per_day IS NULL OR max_patients_per_day > 0));
CREATE TABLE IF NOT EXISTS family_members (
  id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, relation text NOT NULL, created_at timestamp NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS appointments (
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), user_name text NOT NULL, mobile text NOT NULL,
  doctor_id integer REFERENCES doctors(id), hospital_id integer REFERENCES hospitals(id),
  appointment_date date NOT NULL, token_number integer NOT NULL, status text DEFAULT 'booked',
  created_at timestamp DEFAULT CURRENT_TIMESTAMP, slot_number integer, slot_start time, slot_end time,
  family_member_id integer REFERENCES family_members(id) ON DELETE SET NULL,
  checked_in_at timestamp, reminder_sent_at timestamp, reason_for_visit text, visit_notes text,
  priority text DEFAULT 'normal' CHECK (priority IN ('normal','emergency')),
  UNIQUE (doctor_id, appointment_date, token_number));
CREATE TABLE IF NOT EXISTS notifications (
  id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id integer REFERENCES appointments(id) ON DELETE SET NULL,
  type text NOT NULL CONSTRAINT notifications_type_check CHECK (type IN ('booking_created','booking_cancelled','booking_rescheduled')),
  title text NOT NULL, message text NOT NULL, read_at timestamp, created_at timestamp NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS favorite_doctors (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id integer NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, doctor_id));
CREATE TABLE IF NOT EXISTS favorite_hospitals (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hospital_id integer NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, hospital_id));
CREATE TABLE IF NOT EXISTS doctor_leaves (
  id serial PRIMARY KEY, doctor_id integer NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  leave_date date NOT NULL, reason text, created_at timestamp NOT NULL DEFAULT NOW(),
  UNIQUE (doctor_id, leave_date));
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date_slot ON appointments (doctor_id, appointment_date, slot_number);
CREATE INDEX IF NOT EXISTS idx_appointments_user_date ON appointments (user_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date_priority ON appointments (doctor_id, appointment_date, priority, token_number);
CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_members (user_id);
CREATE INDEX IF NOT EXISTS idx_doctor_leaves_doctor_date ON doctor_leaves (doctor_id, leave_date);
CREATE INDEX IF NOT EXISTS idx_doctors_department ON doctors (department_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, read_at);
