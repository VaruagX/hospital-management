# PulseCare HMS — OPD Token & Queue System: Rebuild Plan

**Branch:** `rebuild/opd-queue`  
**Snapshot commit:** `283ab4f` — "WIP: snapshot before rebuild"  
**Plan date:** 2026-10-24  
**Author:** Antigravity (AI coding assistant)

---

## 1. `syncUser` behavior — confirmed before any work begins

`server/auth.js:6-41` was read and confirmed:

| Behavior | Detail |
|---|---|
| **Lookup key** | `email` — `SELECT * FROM users WHERE email = $1 LIMIT 1` |
| **Existing user** | `role = forcedRole \|\| existingUser.role \|\| "patient"` — **existing role is preserved** unless the email is the configured admin email |
| **New user** | Inserted with `role = "patient"` (or `"admin"` if admin email) |
| **Admin enforcement** | `isAdminEmail(email)` forces `role = "admin"` unconditionally |
| **Staff pre-creation works** | An admin inserts a row with `role='receptionist'` and the correct email. When that person signs in via Google, `syncUser` finds the row, keeps `role='receptionist'`, updates `name` and `photo`. ✅ No auth changes needed. |
| **Fields returned** | `id, name, email, photo, role, phone` — `deserializeUser` selects the same columns |
| **One addition needed** | `deserializeUser` SELECT (line 74) must also return `hospital_id, doctor_id, is_active` after those columns are added to `users`. This is a one-line SQL change; no Passport strategy, serialize, or callback logic changes. |

---

## 2. Local database setup

| Item | Value |
|---|---|
| Dev database | `postgresql://localhost:5432/pulsecare_dev` |
| Test database | `postgresql://localhost:5432/pulsecare_test` |
| PostgreSQL | 18.3 via Homebrew, running on localhost:5432 |
| User | `gauravkale` |
| Production DB | Neon cloud — **never touched by dev tooling** |

The project will use `LOCAL_DATABASE_URL` (dev) and `TEST_DATABASE_URL` (test) env vars for all local work. `DATABASE_URL` is reserved for production only.

---

## 3. What currently exists (inferred from source — local DB is fresh/empty)

### Baseline tables (not in repo DDL — assumed pre-existing from original setup)

| Table | Columns known from SQL queries in controllers |
|---|---|
| `users` | `id`, `email`, `name`, `photo`, `role`, `phone` |
| `cities` | `id`, `name` |
| `hospitals` | `id`, `city_id`, `name`, `location` |
| `doctors` | `id`, `hospital_id`, `name`, `specialization`, `available_from`, `available_to`, `unavailable_days`, `availability_note` |
| `appointments` | `id`, `user_id`, `user_name`, `mobile`, `doctor_id`, `hospital_id`, `appointment_date`, `token_number`, `status` |

### Columns added by `schema.js` (the startup mutation script)

| Table | Added columns |
|---|---|
| `users` | `phone` |
| `doctors` | `department_id`, `max_patients_per_day`, `slot_step_minutes`, `slot_duration_minutes` |
| `appointments` | `slot_number`, `slot_start`, `slot_end`, `family_member_id`, `checked_in_at`, `reminder_sent_at`, `reason_for_visit`, `visit_notes`, `priority` |

### Tables created by `schema.js`

`notifications`, `departments`, `family_members`, `favorite_doctors`, `favorite_hospitals`, `doctor_leaves`

---

## 4. What will be REMOVED

| Item | Reason |
|---|---|
| `server/config/schema.js` | Replaced by versioned migrations. The `ensureSchema()` call in `server.js` is also removed. |
| `server/controllers/adminController.js` | Replaced by new role-scoped controllers (`hospitalAdminController`, `receptionController`, `doctorController`, `superAdminController`) |
| `server/controllers/bookingController.js` | Replaced by `tokenController.js` (new token model, new status machine) |
| `server/controllers/dataController.js` | Replaced by public API controllers (`publicController`, `patientController`) |
| `server/controllers/patientController.js` | Merged into new `patientController.js` (family members, favorites, profile) |
| `server/routes/adminRoutes.js` | Replaced by new role-scoped route files |
| `server/routes/apiRoutes.js` | Replaced by new route files |
| `client/script.js` (monolith) | Replaced by modular `client/js/` ES-module files |
| `client/index.html` (monolith) | Replaced by feature-specific page shells + shared layout |
| `client/style.css` (monolith) | Replaced by `client/css/` split by component |
| `server/services/reminderService.js` | Disabled behind `ENABLE_REMINDERS=false` flag; kept in codebase but not auto-started |

**NOT removed:**
- `server/auth.js` — kept exactly as-is
- `server/routes/authRoutes.js` — kept exactly as-is
- `server/controllers/authController.js` — kept exactly as-is
- `server/config/db.js` — kept, but updated to use `LOCAL_DATABASE_URL` when `NODE_ENV !== production`
- `server/config/runtime.js` — kept as-is

---

## 5. What will be KEPT unchanged

| File | Status |
|---|---|
| `server/auth.js` | 🔒 Frozen — Google strategy, syncUser, serialize/deserialize |
| `server/routes/authRoutes.js` | 🔒 Frozen — `/auth/google`, `/auth/google/callback`, `/api/session`, `/api/logout` |
| `server/controllers/authController.js` | 🔒 Frozen — getSession, logout |
| `server/config/runtime.js` | 🔒 Frozen — BASE_URL, ADMIN_EMAIL, SESSION_SECRET, isAdminEmail |
| `.env` | 🔒 Never modified |

---

## 6. What will be CREATED

### Infrastructure

| File | Purpose |
|---|---|
| `db/migrate.js` | Migration runner: reads `db/migrations/*.sql` in order, records applied in `schema_migrations` |
| `db/migrations/001_baseline.sql` | Creates `schema_migrations` table and baseline tables from first principles |
| `db/migrations/002_alter_existing.sql` | ALTER existing tables to add new columns (keeping all data) |
| `db/migrations/003_new_tables.sql` | Creates `tokens`, `token_events`, `notifications` (new schema), `sessions`, `family_members`, `doctor_leaves`, `favorites`, `departments` |
| `db/migrations/004_rename_appointments.sql` | Renames `appointments` → `legacy_appointments` |
| `db/migrations/005_indexes.sql` | All performance indexes |
| `db/seed.dev.js` | Demo data for local dev only (cities, hospitals, doctors, tokens) |

### Server

| File | Purpose |
|---|---|
| `server/config/db.js` | Updated: uses `LOCAL_DATABASE_URL` in dev, `DATABASE_URL` in production |
| `server/middleware/auth.js` | Updated: new roles (`receptionist`, `hospital_admin`), `is_active` check, resource ownership helpers |
| `server/policies/index.js` | Policy functions: `canManageHospital`, `canOperateDoctorQueue`, `canViewToken`, etc. |
| `server/validation/schemas.js` | Zod schemas for every request body |
| `server/routes/publicRoutes.js` | Cities, hospitals, doctors — public (no auth required) |
| `server/routes/patientRoutes.js` | Token booking, my tokens, family members, profile, notifications |
| `server/routes/receptionRoutes.js` | Walk-ins, check-in, requeue, status for reception staff |
| `server/routes/doctorRoutes.js` | Doctor queue, call next, complete, skip, visit notes |
| `server/routes/hospitalAdminRoutes.js` | Hospital info, doctors, schedules, leaves, staff accounts |
| `server/routes/superAdminRoutes.js` | Cities, hospitals, partner flag, global stats |
| `server/controllers/publicController.js` | City/hospital/doctor browsing, TV display data |
| `server/controllers/patientController.js` | Token booking, my tokens, family members, profile, notifications |
| `server/controllers/tokenController.js` | Core queue engine: book, walk-in, status transitions, live status |
| `server/controllers/receptionController.js` | Walk-in add, check-in, requeue, emergency, no-show |
| `server/controllers/doctorController.js` | Call next, complete, skip, visit notes |
| `server/controllers/hospitalAdminController.js` | Hospital management |
| `server/controllers/superAdminController.js` | Super admin operations |
| `server/controllers/staffController.js` | Staff account creation/deactivation |
| `server/services/reminderService.js` | Updated: gated behind `ENABLE_REMINDERS` env flag |

### Client (rebuilt from scratch, modular ES modules)

```
client/
  index.html                 App shell with <nav>, <main id="app">, <div id="toast">
  css/
    base.css                 Reset, variables, typography, colors
    layout.css               Nav, page containers, responsive grid
    components.css           Cards, buttons, forms, badges, modals
    print.css                Token slip print styles
  js/
    strings.js               All UI text in English (i18n-ready)
    api.js                   fetch wrapper, credentials:include, error handling
    router.js                History API router, popstate, route table
    auth.js                  Session check, login redirect, role guards
    components/
      toast.js               Toast notifications
      modal.js               Modal dialog
      spinner.js             Loading states
      tokenCard.js           Live token card component (patient view)
    pages/
      home.js                Landing, search, city chips, "how it works"
      city.js                City page — hospitals list
      hospital.js            Hospital detail page
      doctor.js              Doctor detail + today's queue status
      bookToken.js           Booking wizard (date, patient, reason, confirm)
      myTokens.js            My tokens with live polling
      familyMembers.js       Family member management
      profile.js             User profile
      notifications.js       In-app notifications
      reception.js           Reception console
      doctorConsole.js       Doctor queue console
      hospitalAdmin.js       Hospital admin pages
      superAdmin.js          Super admin pages
      tvDisplay.js           TV display /display/hospital/:id
      notFound.js            404 page
```

---

## 7. Data model changes (migrations overview)

### `users` — ALTER (add nullable columns)
- `phone` (already exists via schema.js)
- `hospital_id INTEGER REFERENCES hospitals(id)` (nullable)
- `doctor_id INTEGER REFERENCES doctors(id)` (nullable)
- `is_active BOOLEAN DEFAULT TRUE`
- `created_at TIMESTAMP DEFAULT NOW()`

### `cities` — ALTER
- `is_active BOOLEAN DEFAULT TRUE`

### `hospitals` — ALTER
- `is_partner BOOLEAN DEFAULT FALSE`
- `is_active BOOLEAN DEFAULT TRUE`
- `address TEXT`
- `phone TEXT`
- `map_url TEXT`
- `about TEXT`
- `opd_timings_text TEXT`
- `updated_at TIMESTAMP DEFAULT NOW()`

### `departments` — already created by schema.js, keep as-is

### `doctors` — ALTER (add new columns alongside existing)
- `qualification TEXT`
- `experience_years INTEGER`
- `opd_days INTEGER[]` (weekday numbers 0–6; replaces `unavailable_days` string)
- `opd_start TIME` (replaces `available_from`)
- `opd_end TIME` (replaces `available_to`)
- `avg_consult_minutes INTEGER DEFAULT 10`
- `max_tokens_per_day INTEGER DEFAULT 40`
- `online_token_quota INTEGER DEFAULT 25`
- `is_active BOOLEAN DEFAULT TRUE`

> [!NOTE]  
> Existing `available_from`, `available_to`, `unavailable_days`, `slot_step_minutes`, `slot_duration_minutes`, `max_patients_per_day` are kept (not dropped) to preserve historical data and allow gradual migration.

### `tokens` — CREATE NEW (replaces appointments for new bookings)

```sql
CREATE TABLE tokens (
  id                  SERIAL PRIMARY KEY,
  hospital_id         INTEGER NOT NULL REFERENCES hospitals(id),
  doctor_id           INTEGER NOT NULL REFERENCES doctors(id),
  token_date          DATE NOT NULL,
  token_number        INTEGER NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('online','walkin')),
  booked_by_user_id   INTEGER REFERENCES users(id),
  family_member_id    INTEGER REFERENCES family_members(id),
  patient_name        TEXT NOT NULL,
  patient_phone       TEXT,
  patient_age         INTEGER,
  patient_gender      TEXT CHECK (patient_gender IN ('male','female','other')),
  reason              TEXT CHECK (char_length(reason) <= 300),
  priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','emergency')),
  status              TEXT NOT NULL DEFAULT 'booked'
                      CHECK (status IN ('booked','checked_in','called','completed','skipped','no_show','cancelled')),
  queue_order         NUMERIC NOT NULL,
  checked_in_at       TIMESTAMP,
  called_at           TIMESTAMP,
  completed_at        TIMESTAMP,
  cancelled_at        TIMESTAMP,
  visit_notes         TEXT,
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (doctor_id, token_date, token_number)
);
CREATE INDEX idx_tokens_queue ON tokens (doctor_id, token_date, status, priority, queue_order);
CREATE INDEX idx_tokens_patient ON tokens (booked_by_user_id, token_date);
CREATE INDEX idx_tokens_hospital_date ON tokens (hospital_id, token_date);
```

### `token_events` — CREATE NEW (audit log)
```sql
CREATE TABLE token_events (
  id            SERIAL PRIMARY KEY,
  token_id      INTEGER NOT NULL REFERENCES tokens(id),
  from_status   TEXT,
  to_status     TEXT,
  action        TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  note          TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### `notifications` — recreate with new schema
Old notifications reference `appointment_id`. New ones reference `token_id`. The old `notifications` table is renamed `legacy_notifications`; a new `notifications` table is created.

### `sessions` — CREATE NEW (connect-pg-simple)
```sql
CREATE TABLE sessions (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_sessions_expire ON sessions (expire);
```

### `appointments` → `legacy_appointments`
`ALTER TABLE appointments RENAME TO legacy_appointments;`  
Old code that references `appointments` is **entirely removed** and never runs. New code never touches `legacy_appointments`.

---

## 8. Authorization matrix

| Role | Created by | Resource scope |
|---|---|---|
| `patient` | Google sign-in (default) | Own tokens + family member tokens |
| `receptionist` | hospital_admin or admin | `hospital_id = user.hospital_id` only |
| `doctor` | hospital_admin or admin | `doctor_id = user.doctor_id` only |
| `hospital_admin` | admin only | `hospital_id = user.hospital_id` only |
| `admin` | Configured email (forced) | Everything |

**Inactive users** (`is_active = false`) get 403 on all staff routes.

---

## 9. Queue rules summary

| Rule | Implementation |
|---|---|
| Advisory lock | `pg_advisory_xact_lock(hashtext(doctor_id::text \|\| ':' \|\| date))` |
| Token number | `COALESCE(MAX(token_number), 0) + 1` within lock |
| Safety net | `UNIQUE(doctor_id, token_date, token_number)` — on conflict, retry once |
| Online quota | `COUNT WHERE source='online' AND status <> 'cancelled'` < `online_token_quota` |
| Total quota | `COUNT WHERE status <> 'cancelled'` < `max_tokens_per_day` |
| Walk-in | Counts toward total, not online quota; created as `checked_in` |
| Now serving | Persisted `status = 'called'` (not computed) |
| Call next | Only if no `called` token exists; next = emergency first, then lowest `queue_order` |
| Live updates | Poll every 10 s; pause when tab hidden |
| Reporting time | `opd_start + (token_number - 1) × avg_consult_minutes` (labelled "approximate") |

---

## 10. Status transition machine

```
booked ──────────────────────────────────────────► cancelled  (patient/receptionist)
booked ──────────────────────────────────────────► no_show    (receptionist / auto)
booked ──────────────────────────────────────────► checked_in (patient self / receptionist)
checked_in ──────────────────────────────────────► called     (doctor: call next / call this)
checked_in ──────────────────────────────────────► cancelled  (receptionist)
called ───────────────────────────────────────────► completed  (doctor)
called ───────────────────────────────────────────► skipped   (doctor)
skipped ──────────────────────────────────────────► checked_in (receptionist requeue)
```

Every transition writes a row to `token_events`.

---

## 11. SMTP reminders

The existing `reminderService.js` references `appointments.reminder_sent_at` which will no longer exist on the active table. It is kept in the codebase but:
- Gated behind `ENABLE_REMINDERS=false` in `.env.example`
- Not auto-started in `server.js` when the flag is false
- Documented in the README as "disabled pending adaptation to the `tokens` table"

---

## 12. Package.json scripts to add

| Script | Command |
|---|---|
| `start` | `node server/server.js` |
| `dev` | `node --watch server/server.js` |
| `migrate` | `node db/migrate.js up` |
| `migrate:down` | `node db/migrate.js down` |
| `seed:dev` | `node db/seed.dev.js` |
| `test` | `node --test test/**/*.test.js` |

---

## 13. Phases checklist

- [x] **Phase 1 — Inspect and plan** ← YOU ARE HERE
  - [x] Read codebase and audit document
  - [x] Confirm `syncUser` behavior
  - [x] Created `rebuild/opd-queue` branch
  - [x] Snapshot commit `283ab4f`
  - [x] Created local databases (`pulsecare_dev`, `pulsecare_test`)
  - [x] Updated `.env.example`
  - [x] Written this plan
- [ ] **Phase 2 — Foundation** (migration runner, migrations, session store, zod, policies, tests, /health /ready)
- [ ] **Phase 3 — Public browsing and hospital data**
- [ ] **Phase 4 — Patient tokens**
- [ ] **Phase 5 — Staff consoles**
- [ ] **Phase 6 — Admin pages and TV display**
- [ ] **Phase 7 — Polish and docs**

---

## 14. Files touched in Phase 1

| File | Change |
|---|---|
| `.env.example` | Added `LOCAL_DATABASE_URL`, `TEST_DATABASE_URL`, `ENABLE_REMINDERS`; variable names only, no secrets |
| `docs/REBUILD_PLAN.md` | Created (this file) |
| All other files | Unchanged (snapshot commit only) |
