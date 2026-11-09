# Reminder pipeline: bookings tables brief (issue #19)

Date: 2026-11-09
Status: research only. No migration or code was changed in this pass.

## Why this matters

The reminder pipeline (`appointment.reminder_sent`) is behind `CHATBOT_REMINDERS_ENABLED`, which is off by default. It cannot run in production because the bookings tables it reads are not in the promoted migrations. Their only definitions are in drafts under `server/modules/chatbot/db/migrations-draft/`.

## Result in one line

The pipeline's ledger and outbox tables are already promoted (`migrations/0016_chatbot_reminder_pipeline.sql`). The two tables it reads for bookings, `chatbot_appointments` and `chatbot_booking_calendars`, exist only in the draft `0000_bookings_tables.sql`.

## Table status

| Table | Status | Defined in | What is missing | Recommended path and reason |
|---|---|---|---|---|
| `chatbot_appointments` | Draft only | `migrations-draft/0000_bookings_tables.sql` | Nothing the pipeline needs. The draft has every column it reads. | **Promote the draft (appointments part).** The pipeline reads every bookings row through this table, so nothing runs without it. |
| `chatbot_booking_calendars` | Draft only | `migrations-draft/0000_bookings_tables.sql` | Nothing the pipeline needs. The draft has `id`, `name`, `timezone`, `buffer_minutes`. | **Promote with the appointments part.** Appointments reference calendars, and the pipeline reads each calendar's timezone for the reminder text. |
| `chatbot_booking_reminder_sends` | Promoted (partial) | `migrations/0016_chatbot_reminder_pipeline.sql` | The foreign key to `chatbot_appointments` is missing. 0016 says so on purpose. | **Write a new migration after the appointments table is promoted.** It adds the foreign key. This is additive. Until then the ledger works without the key. |
| `chatbot_booking_reminder_attempts` | Promoted | `migrations/0016_chatbot_reminder_pipeline.sql` | Nothing. | **No action.** |
| `chatbot_event_outbox` | Promoted | `migrations/0016_chatbot_reminder_pipeline.sql` | Nothing. | **No action.** The reminder-sent hook writes here. |

## Tables in the draft that the pipeline does not need

| Table or change | Status | Defined in | Recommended path and reason |
|---|---|---|---|
| `chatbot_booking_reminders` | Draft only | `migrations-draft/0000_bookings_tables.sql` | **Do not promote.** The dispatcher keeps its own ledger (`chatbot_booking_reminder_sends`). `booking-providers/DECISIONS.md` R7 says these rows are not used. |
| `chatbot_booking_settings` | Draft only | `migrations-draft/0000_bookings_tables.sql` | **Wait.** Holds the Calendly token. The reminder pipeline does not read it. |
| Booking columns on `chatbots` | Draft only | `migrations-draft/0000_bookings_tables.sql` | **Wait.** Booking-assistant feature, not reminders. |
| Double-booking guard (EXCLUDE constraint) | Draft only | `migrations-draft/0001_bookings_exclusion.sql` | **Wait.** It is a separate safety layer for new bookings. The pipeline does not need it. It must run after the 0000 part. The draft is not yet tested against Postgres. |

## Columns the pipeline reads and writes

Reads (through the bookings service, `listCalendars` and `listAppointments`):

- `chatbot_booking_calendars`: id, name, timezone, buffer_minutes, availability, company_id, created_at, updated_at
- `chatbot_appointments`: id, company_id, calendar_id, conversation_id, customer_name, customer_email, customer_phone, starts_at, ends_at, status, status_reason, metadata, created_at, updated_at

Writes:

- `chatbot_booking_reminder_sends`: company_id, appointment_id, channel, status, idempotency_key, external_message_id, reason, created_at, updated_at
- `chatbot_booking_reminder_attempts`: company_id, appointment_id, channel, attempt_no, status, idempotency_key, external_message_id, reason, attempted_at
- `chatbot_event_outbox`: the `appointment.reminder_sent` event row

## Suggested order

1. Check the draft 0000 (appointments and calendars parts only) on a fresh database. The draft says it has never been run against Postgres.
2. Promote those two tables as a new additive migration in `migrations/`, with a rollback block. The next free number after 0016 is 0017. Leave out `chatbot_booking_reminders`, `chatbot_booking_settings` and the `chatbots` columns.
3. Add the foreign key from `chatbot_booking_reminder_sends` to `chatbot_appointments` in a second small migration.
4. Only then consider turning `CHATBOT_REMINDERS_ENABLED` on in the garonhome.local environment.

## Open question for the owner

Should the exclusion guard (draft 0001) be promoted in the same release as the appointments table, or in a later release? This brief recommends later, because it is not needed for reminders.
