# PulseCare — City → Hospital → Doctor → Appointment → Payment → Receipt

Audit and implementation plan. Verified against the code and the live Neon database on 2026-11-08.

## 1. Audit (what exists, verified)

| Area | Reality |
|---|---|
| Stack | Express 4, Passport Google OAuth, `pg`, vanilla JS client (`client/script.js` ~4k lines). No framework, no build step. |
| Auth | Google OAuth only. Roles: `patient`, `admin` (forced from `ADMIN_EMAIL`), plus (since M1) `hospital_admin`, `receptionist`, `doctor`, with `users.hospital_id/doctor_id/is_active`. Sessions use the in-memory store (not durable). |
| Booking | Working 7-step wizard: city → hospital → department → doctor → slot → patient → review. Transactional, advisory-locked, unique `(doctor_id, appointment_date, token_number)`. Slots are generated from `doctors.available_from/available_to/slot_step_minutes/unavailable_days` + `doctor_leaves`. |
| Payments | **None.** No fee column, no gateway, no receipts. |
| Notifications | DB rows for booking created/cancelled/rescheduled + optional SMTP reminders (not configured). |
| Data (Neon) | 1 city, 2 hospitals, 2 doctors, 9 appointments, 3 users, 12 notifications. All preserved. |
| Gaps vs. this brief | No city edit/deactivate; hospital has no description/hours/logo/departments; doctor has no fee/qualification/experience/photo upload; no payments/receipts/slot holds; no patient records linked to bookings; no rate limiting; no PDF; dashboard is not hospital-scoped; client is a monolith. |

Already done (Milestone 1 of the previous round, commit `f2a9e66`): role + hospital/doctor scoping, soft deactivation (no deletes), audit service + viewer, staff assignment, migration-only schema, 31 tests, migrations `000`–`002`, HMS core tables (`001`).

## 2. Architecture decisions

1. **Keep `appointments`** as the booking record. No rename, no recreate (`notifications` too). New payment tables reference it.
2. **Fee lives on the doctor** (`doctors.consultation_fee`). The fee is **snapshotted onto the payment** at booking time so later fee changes never alter old receipts.
3. **Images** are stored in a `media` table (bytea, ≤2 MB, png/jpeg/webp validated by magic bytes) and referenced as `/media/:id` in the existing `image` columns. Rationale: the DB stays the single source of truth and the host disk is ephemeral. No new dependency.
4. **Payments**: a thin gateway module for Razorpay (order create, HMAC signature verification, webhook verification, refund). Confirmation happens **only** server-side after a verified signature or webhook. Tests inject a stub client for the network calls only; the signature check is real crypto.
5. **Slot holds**: appointment status `pending_payment` with `hold_expires_at`. A held slot counts as taken. An expiry job (and lazy cleanup on read) releases abandoned holds.
6. **PDF receipts**: one small dependency (`pdfkit`), generated from verified rows only. HTML print view needs no dependency.
7. **Doctor at multiple hospitals**: not needed now; `doctors.hospital_id` stays single. Revisit only if you need it.
8. Client: split by feature into modules incrementally, redesign tokens first, no framework.

## 3. Milestones (this brief's numbering)

| # | Milestone | Status |
|---|---|---|
| 1 | Audit + architecture | **this document** |
| 2 | Auth/RBAC/DB foundation | **done** (`f2a9e66`) |
| 3 | City and hospital management (+ media, departments) | in progress |
| 4 | Doctor, fee, schedule management | in progress (fee/qualification/experience) |
| 5 | Patient profiles + MRN linkage to bookings | next |
| 6 | Booking workflow with slot holds | |
| 7 | Razorpay create/verify/webhook/refund | needs your **test keys** |
| 8 | Receipts + PDF | |
| 9 | Patient dashboard | |
| 10 | Admin dashboard/analytics | |
| 11 | Records / OPD / IPD / billing | |
| 12 | Premium UI redesign | |
| 13 | E2E + security (rate limiting, uploads) | |

## 4. Safety rules for every milestone
Backup before touching Neon; migrate the local test DB first; additive migrations only; no drops/renames; tests green before commit; your uncommitted edits are never overwritten.
