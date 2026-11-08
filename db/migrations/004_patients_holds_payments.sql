-- 004: Patient records linked to appointments, slot holds, payment/receipt architecture.
-- Additive only. appointments and notifications are kept; existing appointment rows only gain new nullable columns.

-- ---- patients -------------------------------------------------------------
ALTER TABLE patients ADD COLUMN IF NOT EXISTS relation text NOT NULL DEFAULT 'self';
ALTER TABLE patients ADD COLUMN IF NOT EXISTS family_member_id integer REFERENCES family_members(id) ON DELETE SET NULL;
-- One record per person per managing account: same account + same name (+ same DOB) can never be duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_owner_identity
  ON patients (user_id, lower(btrim(full_name)), COALESCE(date_of_birth, DATE '0001-01-01'))
  WHERE user_id IS NOT NULL AND deleted_at IS NULL;

-- ---- appointments: patient link, holds, cancellation info, fee snapshot -------
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS patient_id integer REFERENCES patients(id) ON DELETE SET NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS hold_expires_at timestamp;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at timestamp;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS fee_amount numeric(10,2) CHECK (fee_amount IS NULL OR fee_amount >= 0);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id, appointment_date DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_holds ON appointments (hold_expires_at) WHERE status = 'pending_payment';
-- Database-level double-booking guard: a slot can hold only one non-cancelled appointment (held slots included).
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_active_slot
  ON appointments (doctor_id, appointment_date, slot_number)
  WHERE status IS DISTINCT FROM 'cancelled' AND slot_number IS NOT NULL;

-- ---- backfill: one patient per (account, person name) found in existing appointments ----
INSERT INTO patients (user_id, full_name, phone, email, relation, family_member_id, created_by)
SELECT DISTINCT ON (a.user_id, lower(btrim(a.user_name)))
       a.user_id, btrim(a.user_name), NULLIF(btrim(a.mobile), ''), u.email,
       COALESCE(fm.relation, 'self'), fm.id, a.user_id
FROM appointments a
JOIN users u ON u.id = a.user_id
LEFT JOIN family_members fm ON fm.id = a.family_member_id
WHERE a.user_id IS NOT NULL AND btrim(COALESCE(a.user_name, '')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM patients p
    WHERE p.user_id = a.user_id AND lower(btrim(p.full_name)) = lower(btrim(a.user_name)) AND p.deleted_at IS NULL)
ORDER BY a.user_id, lower(btrim(a.user_name)), a.id DESC;

UPDATE appointments a
SET patient_id = p.id
FROM patients p
WHERE a.patient_id IS NULL
  AND p.user_id = a.user_id AND p.deleted_at IS NULL
  AND lower(btrim(p.full_name)) = lower(btrim(a.user_name));

-- ---- payments ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_payments (
  id serial PRIMARY KEY,
  appointment_id integer NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  patient_id integer REFERENCES patients(id) ON DELETE SET NULL,
  gateway text NOT NULL DEFAULT 'razorpay',
  amount numeric(10,2) NOT NULL CHECK (amount > 0),         -- fee snapshot at booking time
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','paid','refunded','partially_refunded','failed')),
  gateway_order_id text NOT NULL UNIQUE,
  gateway_payment_id text UNIQUE,
  method text,
  attempts integer NOT NULL DEFAULT 0,
  failure_reason text,
  verified_at timestamp,                                    -- set ONLY after signature/webhook verification
  paid_at timestamp,
  created_at timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appt_payments_appt ON appointment_payments (appointment_id);
-- at most one successful payment per appointment
CREATE UNIQUE INDEX IF NOT EXISTS uq_appt_payments_one_paid
  ON appointment_payments (appointment_id) WHERE status IN ('paid','refunded','partially_refunded');

-- Webhook idempotency: each gateway event id is processed once.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamp NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refunds (
  id serial PRIMARY KEY,
  payment_id integer NOT NULL REFERENCES appointment_payments(id) ON DELETE RESTRICT,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  gateway_refund_id text UNIQUE,
  error text,
  requested_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT NOW(),
  processed_at timestamp
);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds (payment_id);

-- Receipts exist only for verified paid appointments.
CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 1000;
CREATE TABLE IF NOT EXISTS receipts (
  id serial PRIMARY KEY,
  receipt_no text NOT NULL UNIQUE DEFAULT ('RC-' || nextval('receipt_no_seq')),
  appointment_id integer NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
  payment_id integer NOT NULL UNIQUE REFERENCES appointment_payments(id) ON DELETE RESTRICT,
  issued_at timestamp NOT NULL DEFAULT NOW()
);
