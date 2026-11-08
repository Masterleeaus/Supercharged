# Chatbot bookings slice: decisions

Source: `Commerce-Crew-main/extensions/chatbot-booking/` (BookingRuntime, Appointment model, WebhookDispatcher,
ExtensionHealthService, FeatureFlags) and the booking-assistant parts of `extensions/chatbot/`.
Test file: `tests/modules/chatbot-bookings.test.mjs` (38 tests, all passing).

Items marked **REVIEW** need the owner's decision before this is merged.

## Existing Desk code checked first

- `server/modules/booking-agent/`: a port of PhoneCallAgent's booking tools. It is provider-based (Cal.com or Calendly
  style), has an approvals gate, and uses zod schemas and in-memory adapters that are keyed by companyId. Not reused: it
  models a remote calendar, not local calendars with working hours. Its patterns (company-first maps, strict input
  objects, E.164 regex, email check, ISO 8601 with an offset for times) were the reference for this slice.
- `shared/schema.ts` `appointments` and `appointment_settings`: user-scoped (`user_id` not null), `company_id` nullable,
  no overlap guard. Not reused. The new `chatbot_*` tables are separate. **REVIEW:** confirm the owner does not want the
  chatbot bookings to land in the existing `appointments` table instead.
- `server/services/appointment-elevenlabs-tool.ts` and `google-calendar.service.ts`: the voice-call appointment flow. Not reused.
- `tests/security/appointment-secret-fail-closed.test.mjs`: covers the ElevenLabs appointment webhook secret. Not reused.
  The same principle is applied: the webhook signing secret is required and an empty secret is refused.
- Reused directly: `requireCompanyId` and `ChatbotError` from `chatbot-scope.ts`; the exact-match env flag pattern
  (`=== "1"`) from `server/integrations/titan-field/local-link-route.ts`.
- Not imported: `booking-agent/schemas.ts` exports `isIanaTimezone`, but it imports `zod`, which is not installed in
  this checkout. Importing it breaks the test run. `isValidTimezone` is a local copy with the same behaviour. Swap it
  when zod is present (see `availability.ts`).

## Feature flag

- D1. `CHATBOT_BOOKINGS_ENABLED`, default OFF. Only the exact value `"1"` enables it. Read by `isBookingsEnabled(env)`.
- D2. With the flag off, every booking service method throws 503. The booking-assistant instruction returns `null`.
  The tag is never stripped or reported.
- D3. The service takes `enabled` as a dependency. The default reads the environment. Tests pass it explicitly.

## Domain logic

- D4. **REVIEW: waitlisted rows do not block slots.** The PHP busy list excluded only `cancelled`, so waitlisted rows
  blocked time. A waitlist entry should not hold a slot. Promotion re-checks the slot, so nothing is double-booked.
- D5. Statuses are `confirmed`, `waitlisted`, `cancelled`, taken from the PHP writes. The default is `confirmed`.
- D6. State machine: confirmed to cancelled; waitlisted to confirmed or cancelled; cancelled is terminal. The PHP never
  checked transitions, so this is new. A transition that is not allowed returns 409.
- D7. No reschedule operation. The PHP runtime had none. `booking-agent` has a reschedule, but for a remote provider.
- D8. **REVIEW: overlap rule.** Two intervals conflict when `a.start < b.end + buffer AND b.start < a.end + buffer`.
  This means a gap of at least `buffer_minutes` is required. The buffer is new (the PHP had none); the default is 0.
  The rule is chosen so the DB exclusion constraint can express it (see D16). UNVERIFIED against Postgres: the constraint is a draft and has not been run.
- D9. Double booking is prevented inside storage (UNVERIFIED against Postgres). `insertAppointment` and `transitionAppointment` check and write in one
  step. The PHP `book()` was a plain insert with no check, which allowed double booking. Ten concurrent bookings for one
  slot leave one confirmed row (tested).
- D10. **REVIEW: free slots come from working hours.** The PHP `available()` returned only busy rows and ignored
  `availability` and `timezone`. This port generates slots from `availability` in the calendar timezone, minus confirmed
  bookings (plus buffer), and never offers a past time.
- D11. **REVIEW: `availability` format.** The PHP column was untyped JSON. This port uses the same weekly shape as
  `appointment_settings.working_hours` (`{ monday: { enabled, start, end }, ... }`), mirrored locally, not imported.
  A null availability offers no slots (fail closed).
- D12. Slot length defaults to 30 minutes (range 5 to 480). The slot grid is anchored to the working-hours start, not to
  the query start or to now (an early version drifted off the hour; it is fixed and covered by a test).
- D13. **REVIEW: bookings must fall fully inside working hours.** The PHP accepted any time. Waitlist entries are held to
  the same rule.
- D14. Bookings must start in the future, and must be at least 5 minutes long and at most 480 minutes.
- D15. Range queries are at most 31 days (new limit). Metadata is at most 4 KB (new limit).
- D16. Storage carries a `blocked_range` column in the Drizzle draft. The migration should make it `tstzrange`, with
  `[starts_at, ends_at + buffer)`, and add an EXCLUDE constraint with `btree_gist`. This is written as a comment in
  `schema.DRAFT.ts` and must go in the migration SQL. No migration has been run. A draft is at `db/migrations-draft/0001_bookings_exclusion.sql`, not applied. UNVERIFIED against Postgres.
- D17. Availability responses return busy times only (start and end). Customer details are never returned. The PHP
  already selected only `starts_at` and `ends_at`.
- D18. **REVIEW: customer contact.** The PHP made name, email and phone nullable. This port requires a name and at least
  one of email or phone. Email must be a plain address. Phone must be E.164 (the booking-agent rule).
- D19. Unknown keys in any input are rejected with 422. This includes `companyId` and `status`. The PHP `$guarded = []`
  allowed mass assignment of any column.
- D20. Reminders: channel must be one of email, sms, whatsapp, telegram or web (the PHP accepted any string). Statuses are
  queued, sent, failed or cancelled (the PHP only ever wrote queued). `send_at` must be after now and before the
  appointment starts. A reminder cannot be added to a cancelled appointment.
- D21. Cancellation reason is optional and at most 500 characters.
- D22. DST: wall times in a DST gap (for example 02:30 on the spring-forward day) resolve to a neighbouring instant. This
  is documented in `zonedWallTimeToInstant`. It is not tested.

## Events, webhooks and health

- D23. `BookingEventSink` is a port with a no-op default. Events: `appointment.booked`, `appointment.waitlisted`,
  `appointment.status_changed`, `reminder.scheduled`.
- D24. Event payloads carry ids, status and times only. Customer name, email and phone are never sent (tested).
- D25. Signing: HMAC-SHA256 hex over the exact serialised body, sent in `X-Chatbot-Signature` (same header name as PHP).
  The PHP signed `json_encode($body)` and then let Laravel encode the body again, so the signed and sent bytes could differ.
  This port builds the body once and signs that string.
- D26. An empty secret throws. The PHP defaulted the secret to `''`, which made the HMAC forgeable.
- D27. Out of scope: the HTTP POST itself (`WebhookDispatcher::dispatch` used `Http::post`). The integration layer posts
  the body from `buildSignedBookingRequest`.
- D28. Health: the probe is injected. A failing probe reports `database: false`. The raw error message is not returned
  (the PHP returned it). The `configuration` check is passed in by the caller.

## Booking assistant

- D29. The five default conditions are copied verbatim as data. They are the owner-facing defaults.
- D30. The prompt text is written fresh for this port, not copied. The tag stays `[booking-assistant]` because the chatbot
  generators and the frontend depend on it.
- D31. Stored conditions are cleaned: whitespace collapsed, newlines removed, empties and non-strings dropped, duplicates
  removed, at most 20 items of 200 characters (new limits). If nothing usable remains, the defaults apply. This matches
  the PHP truthiness check on the array.
- D32. Only a trailing tag is removed, and only when the assistant is active. A tag in the middle of a reply is left alone.
- D33. The `booking_assistant_iframe` column is defined in `schema.DRAFT.ts`. The iframe rendering is UI and is out of scope.

## Storage and schema

- D34. `BookingStorage` is an interface with an in-memory implementation. Every method takes `companyId` first and calls
  `requireCompanyId` (403 on a missing or non-UUID value). The storage refuses to attach an appointment to a calendar in
  another company (tested).
- D35. No Drizzle implementation of `BookingStorage` is included. The contract is ready for one. Writing it needs a
  transaction and the EXCLUDE constraint in D16.
- D36. `schema.DRAFT.ts` defines `chatbot_booking_calendars`, `chatbot_appointments` and `chatbot_booking_reminders`, with
  composite FKs on `(company_id, id)`. `chatbot_appointments.conversation_id` references `chatbot_conversations` from
  `../schema.DRAFT.ts`. If that fragment changes, this import must change too.
- D37. The booking-assistant columns (`is_booking_assistant`, `booking_assistant_conditions`, `booking_assistant_iframe`)
  belong on `chatbots`. They are exported as `bookingAssistantChatbotColumns` for the chatbot slice to spread in. The
  chatbot fragment was not edited.
- D38. `blocked_range` was typed as `text` in the draft as a placeholder. Use `tstzrange` in the migration. It is now `tstzrange` in `db/bookings.ts` (UNVERIFIED against Postgres).

## Not ported

- Laravel plumbing: ServiceProvider, routes, controller `index` view, policies, `extension.json`, `upgrade.php`,
  uninstall (the PHP was a TODO that preserved data), translations and SCSS.
- Models and migrations are ported as TypeScript types and a Drizzle draft. No SQL migration is written.
- `ExtensionLogger`, `Metrics` (no logging or metrics infrastructure in this slice). `config/platform-quality.php` is
  replaced by the feature flag.
- The reminder worker (sending queued reminders), the WebhookDispatcher HTTP transport, and any WhatsApp, Telegram, Ably
  or payment transport. These are out of scope.
- `Http/Requests` and `Http/Resources` were empty folders in the source.

## Verification limits

- `tsc` was not run. This checkout has no `node_modules`, so there is no type check. The tests run with
  `--experimental-transform-types`, which strips types without checking them. Run a typecheck before merge.
- `zod` is not installed here, so `booking-agent` cannot be imported in this checkout.

## Drizzle (2026-11-08)

Files: `../db/bookings.ts` (tables), `drizzle-booking-storage.ts` (storage), `secret-box.ts` (encryption),
`../booking-routes/bookings-adapter.ts` (HTTP adapter). Test: `tests/modules/chatbot-bookings-drizzle.test.mjs`
(56 tests). Nothing is applied to a database. No migration was written; a draft is at `db/migrations-draft/0001_bookings_exclusion.sql` (UNVERIFIED against Postgres).

- DZ1. **Storage location.** `DrizzleBookingStorage` is in `drizzle-booking-storage.ts`, not in `booking-storage.ts`.
  The in-memory path and `index.ts` therefore do not load drizzle or `shared/schema.ts`. The `BookingStorage` interface
  is unchanged; the Drizzle version implements it, and adds the settings and numbering methods listed in DZ4 and DZ8.
- DZ2. **Tables** (in `../db/bookings.ts`): `chatbot_booking_calendars`, `chatbot_appointments`,
  `chatbot_booking_reminders`, `chatbot_booking_settings`. All carry `company_id`. Parent tables come from
  `shared/schema.ts`, which supersedes D36's import from the old draft. `shared/schema.ts` was not edited.
- DZ3. **Double booking, three layers.**
  (a) Drizzle partial unique index on `(company_id, calendar_id, starts_at) WHERE status = 'confirmed'` (UNVERIFIED against Postgres).
  (b) EXCLUDE constraint, written in the migration SQL only (UNVERIFIED against Postgres; draft in `db/migrations-draft/`). Drizzle 0.45 has no EXCLUDE builder. The SQL is in the
  header of `../db/bookings.ts`. `blocked_range` is now a real `tstzrange(starts_at, ends_at + buffer, '[)')`,
  replacing the text placeholder in D38.
  (c) The storage locks the calendar row (`SELECT ... FOR UPDATE`) inside a transaction, then runs the overlap check (UNVERIFIED against Postgres).
  SQLSTATE 23P01 and 23505 are mapped to `overlap` (409 at the service).
- DZ4. **Calendly token.** AES-256-GCM. Key: `CHATBOT_SECRET_KEY`, base64 for exactly 32 bytes. The key is read on
  first use. Missing, empty, wrong length or non-canonical base64 throws `SecretKeyError`. There is no plaintext
  fallback, and a save with no key throws before any query is built. Storage: three columns, `calendly_token_iv`
  (12 bytes), `calendly_token_tag` (16 bytes) and `calendly_token_ciphertext`, all base64. A CHECK keeps them
  all-or-nothing. Clearing the token (null) does not need the key.
- DZ5. **Key rotation.** No key-version column. Rotating the key means re-saving each token. Add a version column before
  the first real rotation. **REVIEW.**
- DZ6. **Token exposure.** `getSettings` returns only `hasCalendlyToken`. `readCalendlyToken` decrypts, for future
  provider calls. The HTTP adapter never calls it.
- DZ7. **Calendar numbers.** The HTTP contract uses numeric `calendarId`, and bookings use UUIDs. The table has a
  `calendar_number` serial, unique per company. The adapter maps between them. **REVIEW:** the simpler fix is to change
  the contract to UUID strings. That is a change to `booking-routes/contract.ts` and `router.ts`, which this pass did not
  touch.
- DZ8. **Adapter (`createBookingRoutesService`).** It builds the routes' `BookingService` from the slice service and
  storage. Used as the `service` option of `createBookingRouter`.
  - Customer name, email and phone come from metadata keys `customer_name`, `customer_email` and `customer_phone`. They
    are moved into their own columns and removed from metadata, and the bookings validator enforces the rules.
    **REVIEW:** the routes contract has no customer fields. Staff therefore cannot see who booked over HTTP. Add them to
    `BookingView` or a separate endpoint.
  - `status: "confirmed"` calls `book()`, and `status: "waitlisted"` calls `waitlist()`.
  - PATCH with a new start, end or metadata answers 422 (no reschedule in the slice; D7). PATCH `status: "confirmed"`
    calls `promote()`, and a 409 is returned if the slot is taken. PATCH `status: "waitlisted"` answers 409, since
    confirmed cannot move back.
  - Cancel and get return `null` for a missing or other-company id, as the contract requires.
  - List requires `from` and `to` (422 otherwise). The slice caps the range at 31 days. Without `calendar_id`, every
    calendar of the company is read. Status filter, sort and paging happen in memory. **REVIEW:** a server-side query
    would be better for large companies.
  - Settings return `calendlyAccessTokenSet` and the conditions list. The adapter maps fields explicitly, so an
    over-returning store cannot leak the token (tested with one).
- DZ9. **Router unchanged.** `router.ts`, `contract.ts`, `schemas.ts` and `DECISIONS.md` in `booking-routes/` are not
  edited in this pass. The booking-routes `DECISIONS.md` line about the Calendly token being plaintext is now out of date
  for the storage path (see DZ4). Update it when the routes are next touched.
- DZ10. **Flags.** The bookings flag (`CHATBOT_BOOKINGS_ENABLED=1`) still gates the service. The Drizzle storage does
  not read flags.
- DZ11. **Tests run with the integration hook.** `/home/claude/builder-test-deps/register.mjs` maps only express and
  zod, so `pg` and `drizzle-orm` do not resolve under it. The Drizzle test needs
  `/home/claude/integration-scratch/hook/register.mjs`. The existing bookings (38), booking-routes (23) and mount (4)
  tests still pass under the integration hook.
- DZ12. **Type check.** Narrow check only, on the four new files, in a scratch config outside the repo. Clean with
  `strict: false` and with `strict: true`. The three errors in `booking-service.ts` (`reason` on a union) come from the
  scratch config's `strict: false` and predate this pass. The file was not changed.
- DZ13. **Not done.** No migration is applied (a draft exists, see DZ3 (b)), no database run, no transaction tested against Postgres (the tests render SQL and
  check the buffer math, but do not execute). The EXCLUDE constraint is not checked. Run the migration against a
  scratch Postgres with `btree_gist` before merge.
