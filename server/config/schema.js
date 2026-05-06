const pool = require("./db");

async function ensureSchema() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone text
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id serial PRIMARY KEY,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        appointment_id integer REFERENCES appointments(id) ON DELETE SET NULL,
        type text NOT NULL,
        title text NOT NULL,
        message text NOT NULL,
        read_at timestamp without time zone,
        created_at timestamp without time zone NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'notifications'
            AND constraint_name = 'notifications_type_check'
        ) THEN
          ALTER TABLE notifications
          ADD CONSTRAINT notifications_type_check
          CHECK (type IN ('booking_created', 'booking_cancelled', 'booking_rescheduled'));
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        created_at timestamp without time zone NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO departments (name)
      VALUES ('Cardiology'), ('Ortho'), ('Neuro')
      ON CONFLICT (name) DO NOTHING
    `);

    await client.query(`
      ALTER TABLE doctors
      ADD COLUMN IF NOT EXISTS department_id integer
    `);
    await client.query(`
      ALTER TABLE doctors
      ADD COLUMN IF NOT EXISTS max_patients_per_day integer
    `);
    await client.query(`
      UPDATE doctors
      SET max_patients_per_day = 24
      WHERE max_patients_per_day IS NULL
    `);
    await client.query(`
      ALTER TABLE doctors
      ALTER COLUMN max_patients_per_day SET DEFAULT 24
    `);
    await client.query(`
      UPDATE doctors d
      SET department_id = dep.id
      FROM departments dep
      WHERE d.department_id IS NULL
        AND (
          (dep.name = 'Cardiology' AND LOWER(COALESCE(d.specialization, '')) LIKE '%cardio%')
          OR (dep.name = 'Ortho' AND (
            LOWER(COALESCE(d.specialization, '')) LIKE '%ortho%'
            OR LOWER(COALESCE(d.specialization, '')) LIKE '%bone%'
          ))
          OR (dep.name = 'Neuro' AND LOWER(COALESCE(d.specialization, '')) LIKE '%neuro%')
        )
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'doctors'
            AND constraint_name = 'doctors_department_id_fkey'
        ) THEN
          ALTER TABLE doctors
          ADD CONSTRAINT doctors_department_id_fkey
          FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'doctors'
            AND constraint_name = 'doctors_max_patients_per_day_positive'
        ) THEN
          ALTER TABLE doctors
          ADD CONSTRAINT doctors_max_patients_per_day_positive
          CHECK (max_patients_per_day IS NULL OR max_patients_per_day > 0);
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE doctors
      ADD COLUMN IF NOT EXISTS slot_step_minutes integer
    `);
    await client.query(`
      ALTER TABLE doctors
      ADD COLUMN IF NOT EXISTS slot_duration_minutes integer
    `);
    await client.query(`
      UPDATE doctors
      SET slot_step_minutes = 15,
          slot_duration_minutes = 15
    `);
    await client.query(`
      ALTER TABLE doctors
      ALTER COLUMN slot_step_minutes SET DEFAULT 15
    `);
    await client.query(`
      ALTER TABLE doctors
      ALTER COLUMN slot_duration_minutes SET DEFAULT 15
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS family_members (
        id serial PRIMARY KEY,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        relation text NOT NULL,
        created_at timestamp without time zone NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS favorite_doctors (
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        doctor_id integer NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
        created_at timestamp without time zone NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, doctor_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS favorite_hospitals (
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hospital_id integer NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
        created_at timestamp without time zone NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, hospital_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_leaves (
        id serial PRIMARY KEY,
        doctor_id integer NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
        leave_date date NOT NULL,
        reason text,
        created_at timestamp without time zone NOT NULL DEFAULT NOW(),
        UNIQUE (doctor_id, leave_date)
      )
    `);

    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS slot_number integer
    `);
    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS slot_start time without time zone
    `);
    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS slot_end time without time zone
    `);
    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS family_member_id integer
    `);
    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS checked_in_at timestamp without time zone
    `);
    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS reminder_sent_at timestamp without time zone
    `);
    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS reason_for_visit text
    `);
    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS visit_notes text
    `);
    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS priority text
    `);
    await client.query(`
      UPDATE appointments
      SET priority = 'normal'
      WHERE priority IS NULL
    `);
    await client.query(`
      ALTER TABLE appointments
      ALTER COLUMN priority SET DEFAULT 'normal'
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'appointments'
            AND constraint_name = 'appointments_priority_check'
        ) THEN
          ALTER TABLE appointments
          ADD CONSTRAINT appointments_priority_check
          CHECK (priority IN ('normal', 'emergency'));
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'appointments'
            AND constraint_name = 'appointments_family_member_id_fkey'
        ) THEN
          ALTER TABLE appointments
          ADD CONSTRAINT appointments_family_member_id_fkey
          FOREIGN KEY (family_member_id) REFERENCES family_members(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      WITH ranked_mobile AS (
        SELECT user_id,
               mobile,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id
                 ORDER BY appointment_date DESC, id DESC
               ) AS row_number
        FROM appointments
        WHERE COALESCE(TRIM(mobile), '') <> ''
      )
      UPDATE users u
      SET phone = ranked_mobile.mobile
      FROM ranked_mobile
      WHERE ranked_mobile.user_id = u.id
        AND ranked_mobile.row_number = 1
        AND COALESCE(TRIM(u.phone), '') = ''
    `);

    await client.query(`
      UPDATE appointments a
      SET slot_number = COALESCE(a.slot_number, a.token_number),
          slot_start = TIME '10:00' + make_interval(
            mins => GREATEST(COALESCE(a.slot_number, a.token_number, 1) - 1, 0) * 15
          ),
          slot_end = TIME '10:00' + make_interval(
            mins => GREATEST(COALESCE(a.slot_number, a.token_number, 1) - 1, 0) * 15 + 15
          )
      FROM doctors d
      WHERE a.doctor_id = d.id
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date_slot
      ON appointments (doctor_id, appointment_date, slot_number)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appointments_user_date
      ON appointments (user_id, appointment_date)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_family_members_user
      ON family_members (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_leaves_doctor_date
      ON doctor_leaves (doctor_id, leave_date)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_department
      ON doctors (department_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date_priority
      ON appointments (doctor_id, appointment_date, priority, token_number)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_created
      ON notifications (user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
      ON notifications (user_id, read_at)
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureSchema,
};
