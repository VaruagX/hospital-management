-- 003: City/hospital/doctor catalog fields, hospital departments, media store. Additive only.

ALTER TABLE cities ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT TRUE;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS deactivated_at timestamp;

ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS logo text;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS opens_at time;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS closes_at time;

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS qualification text;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS experience_years integer CHECK (experience_years IS NULL OR experience_years BETWEEN 0 AND 80);
-- Fee in INR. Snapshotted onto each payment at booking time, so changing it never alters old receipts.
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS consultation_fee numeric(10,2) NOT NULL DEFAULT 0 CHECK (consultation_fee >= 0);

-- Which departments a hospital runs (departments table stays global).
CREATE TABLE IF NOT EXISTS hospital_departments (
  hospital_id integer NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  department_id integer NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hospital_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_hospital_departments_dept ON hospital_departments (department_id);

-- Uploaded images (hospital logo/photos, doctor photos). Referenced from existing text columns as /media/:id.
CREATE TABLE IF NOT EXISTS media (
  id serial PRIMARY KEY,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  content bytea NOT NULL,
  uploaded_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hospitals_city_active ON hospitals (city_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_doctors_hospital_active ON doctors (hospital_id) WHERE is_active;
