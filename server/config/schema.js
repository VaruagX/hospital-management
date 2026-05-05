const pool = require("./db");

async function ensureSchema() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

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
