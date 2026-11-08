-- 001: Hospital-management core. STRICTLY ADDITIVE: no drops, no renames, no data rewrites.
-- Existing tables (users, cities, hospitals, doctors, appointments, ...) keep all rows.

-- Staff scoping + deactivation on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS hospital_id integer REFERENCES hospitals(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_id   integer REFERENCES doctors(id)   ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active   boolean NOT NULL DEFAULT TRUE;

-- Patients (hospital record, separate from login accounts; user_id optional link)
CREATE SEQUENCE IF NOT EXISTS patient_mrn_seq START 1000;
CREATE TABLE IF NOT EXISTS patients (
  id serial PRIMARY KEY,
  mrn text NOT NULL UNIQUE DEFAULT ('PC-' || nextval('patient_mrn_seq')),
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  hospital_id integer REFERENCES hospitals(id) ON DELETE SET NULL,
  full_name text NOT NULL,
  date_of_birth date,
  gender text CHECK (gender IN ('male','female','other')),
  blood_group text,
  phone text,
  email text,
  address text,
  emergency_contact_name text,
  emergency_contact_phone text,
  allergies text,
  chronic_conditions text,
  medical_history text,
  is_emergency boolean NOT NULL DEFAULT FALSE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW(),
  deleted_at timestamp
);
CREATE INDEX IF NOT EXISTS idx_patients_name  ON patients (lower(full_name));
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients (phone);
CREATE INDEX IF NOT EXISTS idx_patients_hosp  ON patients (hospital_id) WHERE deleted_at IS NULL;

-- Visits / consultations (OPD, IPD, emergency)
CREATE TABLE IF NOT EXISTS visits (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  hospital_id integer REFERENCES hospitals(id) ON DELETE SET NULL,
  doctor_id integer REFERENCES doctors(id) ON DELETE SET NULL,
  appointment_id integer REFERENCES appointments(id) ON DELETE SET NULL,
  visit_type text NOT NULL DEFAULT 'opd' CHECK (visit_type IN ('opd','ipd','emergency')),
  visit_date timestamp NOT NULL DEFAULT NOW(),
  complaint text,
  vitals text,
  diagnosis text,
  notes text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits (patient_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visits_doctor  ON visits (doctor_id, visit_date DESC);

-- Wards, beds, admissions (IPD)
CREATE TABLE IF NOT EXISTS wards (
  id serial PRIMARY KEY,
  hospital_id integer NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name text NOT NULL,
  ward_type text NOT NULL DEFAULT 'general',
  daily_charge numeric(10,2) NOT NULL DEFAULT 0 CHECK (daily_charge >= 0),
  UNIQUE (hospital_id, name)
);
CREATE TABLE IF NOT EXISTS beds (
  id serial PRIMARY KEY,
  ward_id integer NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  bed_number text NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','maintenance')),
  UNIQUE (ward_id, bed_number)
);
CREATE TABLE IF NOT EXISTS admissions (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  hospital_id integer REFERENCES hospitals(id) ON DELETE SET NULL,
  bed_id integer REFERENCES beds(id) ON DELETE SET NULL,
  doctor_id integer REFERENCES doctors(id) ON DELETE SET NULL,
  reason text,
  status text NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted','discharged')),
  admitted_at timestamp NOT NULL DEFAULT NOW(),
  discharged_at timestamp,
  discharge_summary text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_admissions_patient ON admissions (patient_id);
-- one active admission per patient, one active admission per bed (DB-enforced)
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_active_patient ON admissions (patient_id) WHERE status = 'admitted';
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_active_bed     ON admissions (bed_id)     WHERE status = 'admitted';

-- Pharmacy
CREATE TABLE IF NOT EXISTS medicines (
  id serial PRIMARY KEY,
  hospital_id integer REFERENCES hospitals(id) ON DELETE CASCADE,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'unit',
  stock_qty integer NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  reorder_level integer NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
  unit_price numeric(10,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamp NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_medicines_name ON medicines (COALESCE(hospital_id,0), lower(name));
CREATE TABLE IF NOT EXISTS prescriptions (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  visit_id integer REFERENCES visits(id) ON DELETE SET NULL,
  doctor_id integer REFERENCES doctors(id) ON DELETE SET NULL,
  notes text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions (patient_id, created_at DESC);
CREATE TABLE IF NOT EXISTS prescription_items (
  id serial PRIMARY KEY,
  prescription_id integer NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medicine_id integer REFERENCES medicines(id) ON DELETE SET NULL,
  medicine_name text NOT NULL,
  dosage text,
  frequency text,
  duration text,
  quantity integer CHECK (quantity IS NULL OR quantity > 0),
  dispensed_at timestamp
);

-- Laboratory
CREATE TABLE IF NOT EXISTS lab_tests (
  id serial PRIMARY KEY,
  hospital_id integer REFERENCES hospitals(id) ON DELETE CASCADE,
  name text NOT NULL,
  price numeric(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  is_active boolean NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_tests_name ON lab_tests (COALESCE(hospital_id,0), lower(name));
CREATE TABLE IF NOT EXISTS lab_orders (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  visit_id integer REFERENCES visits(id) ON DELETE SET NULL,
  lab_test_id integer NOT NULL REFERENCES lab_tests(id),
  ordered_by integer REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','completed','cancelled')),
  result text,
  ordered_at timestamp NOT NULL DEFAULT NOW(),
  reported_at timestamp
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_patient ON lab_orders (patient_id, ordered_at DESC);

-- Patient documents (stored in the DB so it stays the single source of truth)
CREATE TABLE IF NOT EXISTS patient_documents (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  title text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  content bytea NOT NULL,
  uploaded_by integer REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patient_docs_patient ON patient_documents (patient_id);

-- Billing
CREATE TABLE IF NOT EXISTS services (
  id serial PRIMARY KEY,
  hospital_id integer REFERENCES hospitals(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'service',
  price numeric(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  is_active boolean NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_services_name ON services (COALESCE(hospital_id,0), lower(name));
CREATE SEQUENCE IF NOT EXISTS invoice_no_seq START 1000;
CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  invoice_no text NOT NULL UNIQUE DEFAULT ('INV-' || nextval('invoice_no_seq')),
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  hospital_id integer REFERENCES hospitals(id) ON DELETE SET NULL,
  visit_id integer REFERENCES visits(id) ON DELETE SET NULL,
  admission_id integer REFERENCES admissions(id) ON DELETE SET NULL,
  discount numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices (patient_id, created_at DESC);
CREATE TABLE IF NOT EXISTS invoice_items (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL CHECK (unit_price >= 0)
);
CREATE TABLE IF NOT EXISTS payments (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash','card','upi','insurance','other')),
  reference text,
  received_by integer REFERENCES users(id) ON DELETE SET NULL,
  paid_at timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);

-- Audit trail
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  user_email text,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  detail text,
  created_at timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs (entity, entity_id);
