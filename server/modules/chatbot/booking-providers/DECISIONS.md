# Booking providers: decisions

Area: calendar providers (Calendly, Cal.com), retry-safe booking, calendar secrets, reconciliation, and booking reminders.
Test file: `tests/modules/chatbot-booking-providers.test.mjs`: 59 tests, all passing under the integration hook (39 from the
earlier pass, 20 added in this pass).
Type check: scoped strict check (`/tmp/bp-tc2/tsconfig.json`, listing `index.ts`, `booking-caller.ts`, `calendar-secrets.ts`,
`drizzle-retry-store.ts`, `memory-retry-store.ts`, `reconcile-job.ts`, `drizzle-store.ts` and their closure), clean. The full
`tsc` was not run.

Items marked **REVIEW** need the owner's decision before merge. Items marked **UNVERIFIED** could not be checked against
the live provider docs.

## Source

- The PHP extension (`extensions/chatbot-booking/`) has no Calendly or Cal.com code and no reminder sender. Both providers
  are written from the public APIs.
- The bookings slice is used only through its public functions: `listCalendars`, `listAppointments`, `cancel`,
  `DrizzleBookingStorage.readCalendlyToken`. Its files were not edited.
- Provider docs were read on 2026-11-09 with WebFetch and WebSearch. Sources are listed under "Provider API facts".

## Provider API facts

Verified against the public docs. Each item gives the source page.

- P1. **Verified.** Calendly create invitee is `POST https://api.calendly.com/invitees` with `event_type` (URI),
  `start_time` (UTC, ending in Z), `invitee` (`name`, `email`, `timezone`), and an optional `location` that is required
  when the event type has one. Source: https://developer.calendly.com/schedule-events-with-ai-agents
- P1a. **Conflict in the docs, handled both ways.** The invitee page shows `event`, `reschedule_url` and `cancel_url` at the
  top level of the reply. The API conventions page says single resources are wrapped in `resource`. The code reads both
  places and refuses an event URI that is not under this provider's `scheduled_events` path. Source:
  https://developer.calendly.com/api-docs/overview/api/api-conventions.md
- P2. **Verified.** Cal.com `POST https://api.cal.com/v2/bookings` with header `cal-api-version: 2026-02-25`, body `start`
  (UTC), `eventTypeId` (number), `attendee` (`name`, `timeZone`, `email`, `language`), and `metadata` (string values, up to
  50 keys, keys up to 40 characters). The reply has `status` and `data.uid`, `data.start`, `data.end`. Auth is
  `Authorization: Bearer <key>` with a key that starts `cal_`. Source: https://cal.com/docs/api-reference/v2/bookings/create-a-booking
- P2a. **Verified, no idempotency key.** The create page does not mention an idempotency header or key. Retry safety is built
  in this folder (see "Retry-safe booking" below).
- P3. **Verified** Calendly endpoints:
  - available times: `GET https://api.calendly.com/event_type_available_times` with `event_type`, `start_time`, `end_time`.
    The span is at most 31 days. Items have `status` (`available`), `start_time`. Source:
    https://developer.calendly.com/api-docs/calendly-api/event-types/list-event-type-available-times.md
  - scheduled events list: `GET https://api.calendly.com/scheduled_events` with `user`, `min_start_time`, `max_start_time`,
    `count`, `status` (`active` or `canceled`), `page_token`. Items have `uri`, `status`, `start_time`, `end_time`,
    `event_type`. Paging uses `pagination.next_page` (null when done). Source:
    https://developer.calendly.com/api-docs/calendly-api/scheduled-events/list-scheduled-events.md
  - cancel: `POST https://api.calendly.com/scheduled_events/{uuid}/cancellation` with optional `reason`. Reply 201 with
    `resource`. Source: https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-scheduled-event-cancellation.md
  - event types: `GET https://api.calendly.com/event_types` with `user` (or `organization`), `count`. Items have `uri`,
    `name`, `duration`, `active`. Source: https://developer.calendly.com/api-docs/calendly-api/event-types/list-event-types.md
  - webhook signature: header `Calendly-Webhook-Signature`, value `t=<unix seconds>,v1=<hex>`, HMAC-SHA256 over
    `t + "." + raw body`, tolerance 3 minutes. Source: https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures.md
- P3a. **UNVERIFIED** Calendly `GET /users/me` (used to find the user URI for event types and listings). Not on any fetched
  page. The code assumes `resource.uri`, which matches the convention page. Owner to confirm against
  https://developer.calendly.com/api-docs/overview/api/api-conventions.md or the OpenAPI spec.
- P4. **Corrected and verified** Cal.com endpoints. Versions differ from the earlier pass:
  - event types: `GET /v2/event-types`, `cal-api-version: 2024-06-14`. Items have `id`, `title`, `lengthInMinutes`, `hidden`.
    Source: https://cal.com/docs/api-reference/v2/event-types/get-all-event-types.md
  - slots: `GET /v2/slots`, `cal-api-version: 2024-09-04`, required `start` and `end` (UTC), `eventTypeId`, `timeZone`.
    Reply `data` is keyed by date, each slot has `start`. No range limit is documented, so the code keeps 31-day pieces.
    Source: https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type.md
  - cancel: `POST /v2/bookings/{bookingUid}/cancel`, `cal-api-version: 2026-02-25` (was 2024-08-13 in the code; now fixed).
    Body `cancellationReason`. Source: https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking.md
  - list: `GET /v2/bookings`, `cal-api-version: 2026-05-01` (was 2024-08-13; now fixed). **UNVERIFIED** (checked 2026-11-09):
    the official `get-all-bookings` page could not be fetched (not on the session allowlist). The official API v2 reference
    (https://cal.com/docs/_llms/api-v2-reference.md) names no version for this endpoint. The versioning page
    (https://cal.com/docs/enterprise-features/api/versioning) and the v1-v2 differences page
    (https://cal.com/docs/api-reference/v2/v1-v2-differences) name only `2024-08-13`, with no endpoint-specific value. The
    2026-05-01 value and the Nexla connector's `2026-02-25` have no official confirmation. Owner to confirm on the official page. Query: `status` (`upcoming`,
    `recurring`, `past`, `cancelled`, `unconfirmed`), `eventTypeIds`, `afterStart`, `beforeEnd`, `limit` (1 to 100),
    `cursor`. The docs do not have `take` or `skip` (the code used them; now fixed). Reply `pagination.nextCursor` and
    `hasMore`. Booking `status` is `cancelled`, `accepted`, `rejected`, `pending` or `awaiting_host`. `eventTypeId` is
    deprecated; `eventType.id` is used. Source: https://cal.com/docs/api-reference/v2/bookings/get-all-bookings.md
  - webhook header: `x-cal-signature-256`, lower-case hex HMAC-SHA256 over the raw body, no timestamp, so no replay window.
    Source (third party, not the Cal.com page): https://hookdeck.com/webhooks/platforms/guide-to-cal-com-webhooks-features-and-best-practices.md
    **REVIEW:** owner to confirm on the official Cal.com webhook page. The official page could not be fetched.
- P5. Calendly invitee creation has no idempotency key and does not keep our metadata. Retry protection is built in
  `booking-caller.ts`. **Still REVIEW:** a retry that is refused as `outcome_unknown` needs an operator check on the provider.
- P6. **Still open.** A Calendly event type with a required location fails at the provider, because the request has no
  `location` field. **REVIEW:** the owner decides the location source (an event type setting, or a fixed string).
- P7. Cal.com: `metadata` values are capped at 500 characters and keys at 40. The code trims to these limits.

## Retry-safe booking (new in this pass)

- B1. `createBookingCaller(...).book(input)` writes one attempt row per (company, provider, idempotency key) before any
  request. Module: `booking-caller.ts`. Storage: `chatbot_booking_attempts` in `db.ts`.
- B2. A second call with the same key returns the stored booking and sends no request (`replayed: true`). A link that was
  not saved on the first call is saved on the retry.
- B3. Same key, different booking fields (start, end, timezone, name, email, event type): refused as `key_reused`, 409.
  The email is compared without case. The key itself is not in the hash.
- B4. Outcome by failure:
  - `pending`: a call is still running. A second call gets `in_progress`, 409, with no request.
  - `booked`: replayed (B2).
  - `rejected`: the provider refused with a 4xx (not 429), or the call failed before any request (flag off, validation, config).
    A retry with the same key is allowed and makes a new request.
  - `unknown`: a timeout, a network error, a 5xx, or an unreadable 2xx reply. The provider may have booked it. A retry gets `outcome_unknown`, 409, and makes no request.
- B5. A `pending` row that is never settled (the process died mid-call) blocks its key until an operator resolves it. **REVIEW:**
  the owner decides whether a stale-pending sweep should mark those `unknown`. No sweep is built here.
- B6. If the provider accepted a booking but the write to `booked` fails, the row stays `pending` and the caller returns
  `outcome_unknown`. The booking exists on the provider and must be checked by an operator. This is safe (no duplicate) but
  the customer sees a failure. **REVIEW.**
- B7. Errors carry fixed messages and never the key, the body, or a URL.

## Flags and credentials

- F1. Provider methods that touch the network need `CHATBOT_EXTERNAL_CALENDARS_ENABLED` set to exactly `"true"`. With it
  off they throw 503. Webhook verification and parsing do not need the flag, and they fail closed on a missing secret.
- F2. Reminders do not need the flag. They send for native bookings too, and the bookings flag still gates the service
  calls they make.
- F3. **Decided in this pass.** Cal.com's API key and webhook secret are stored through the `SecretBox` contract
  (`contracts/secrets.ts`) in `chatbot_calendar_secrets` (`calendar-secrets.ts`). The box binds the company id as associated
  data. The Calendly token stays in the bookings settings, read by `readCalendlyToken`. Nothing here implements `SecretBox`.
  **Change request and owner step:** `server/modules/chatbot/secrets/secret-box.ts` now exists and exports `createSecretBox`
  (updated 2026-11-09). The caller can pass that box to `createCalendarSecretStore` (updated 2026-11-09).
- F4. The Calendly and Cal.com base URLs must be https. Refused at construction otherwise.

## Token and key safety

- T1. No code logs anything. Keys and tokens are sent only in the `Authorization` header.
- T2. Errors are built from fixed strings. They carry the provider name, the HTTP status, and a code. They never carry the
  response body, the URL, or a header. Transport errors are replaced with a fixed message.
- T3. Provider URLs are built from validated ids (UUID-like for Calendly, numeric for Cal.com event types, a restricted
  pattern for booking uids). A value that does not match is refused before any request. Tests check hostile values
  (absolute URLs, `..`, `?`, `#`, `@`, `%2F`) and assert that no request leaves the provider origin.
- T4. Pagination follows a provider `next_page` URL only when it starts with the base URL. Otherwise the listing fails.
- T5. Credentials are checked for presence only. A missing key error names the key and never a value.
- T6. **New.** A listing that reaches the page limit with more pages still pending now fails (`bad_response`) instead of
  returning a partial list. A partial list would make reconciliation report false discrepancies. Applies to both providers.
- T7. **New.** Cal.com secrets are stored only as sealed values. The test SecretBox in the test file uses AES-256-GCM with
  the company id as associated data. A sealed row copied to another company does not open.

## Webhooks

- W1. Calendly tolerance is 3 minutes, per the Calendly docs. Changed from 5 minutes in the earlier pass.
- W2. Cal.com has no timestamp in its signature, so there is no replay window. **REVIEW:** the owner decides whether a
  webhook needs a dedupe on `providerEventId` (it is built from trigger, uid and createdAt).
- W3. No webhook HTTP route is mounted. Verification and parsing are functions only.

## Reminders

- R1. A reminder is due at (appointment start minus `leadMinutes`). Lead time is an integer from 5 to 10080 minutes.
  A booking that is already inside the lead window when it is made is due at once. **REVIEW:** confirm that is wanted.
- R2. Once per booking per channel. A ledger row keyed by (company, appointment, channel) is claimed before the send.
  Any later run skips it, whatever its status. The sender also gets an idempotency key (`appointmentId:channel:sendAt`).
- R3. Never after cancellation. The booking is read again after the claim. If it is no longer confirmed, the row is set to
  cancelled and nothing is sent. `cancelReminders()` also blocks any later send for the booking.
  **Known limit:** a cancel that lands while the sender is already sending cannot be undone.
- R4. Retryable failures (and a sender that throws) release the claim, so the next run tries again with the same
  idempotency key. Non-retryable failures are terminal. **REVIEW:** a timeout after the provider accepted the message can
  cause a duplicate unless the sender honours the idempotency key.
- R5. Recipient rules: email goes to `customerEmail`, sms and whatsapp go to `customerPhone`, and telegram and web have
  no recipient yet, so they are skipped. **REVIEW:** telegram and web need a rule.
- R6. The reminder text is English, written in the calendar's timezone. The default locale is en-AU. It is configurable.
- R7. The bookings slice's `chatbot_booking_reminders` rows are not used. The dispatcher keeps its own ledger.
  **REVIEW:** the owner may prefer one table; that needs a change to the bookings storage.
- R8. The dispatcher reads bookings only through `listCalendars` and `listAppointments`. It takes all calendars for a
  company and looks ahead by the lead time.

## Reconciliation

- C1. Only links for the company are compared. A link, appointment, or provider booking with another company's id is
  ignored. A provider booking with no link for this company is counted as untracked and never reported or changed.
- C2. Discrepancy kinds: `missing_remote`, `missing_local`, `status_mismatch`, `time_mismatch`. Exact millisecond comparison.
- C3. The result reports; it does not repair. Repair is left to the owner, because a wrong repair could cancel a real
  customer booking.
- C4. **Change request (contracts).** `listBookings` is now an optional method on `CalendarProvider` in
  `contracts/booking-providers.ts` (updated 2026-11-09). Both providers implement it through the `ExternalBookingLister`
  interface in this folder. The owner step to add it to `CalendarProvider` is done (updated 2026-11-09). This folder may
  not edit contracts.
- C5. **New.** `runReconciliationJob(companyId, deps)` (`reconcile-job.ts`) is the worker entry point. It loads one
  company's connection through `loadConnection`, refuses a connection whose company or provider does not match, runs the
  reconciliation over the window (1 day back, 30 days ahead), and returns `reconciled`, `not_connected`, or `failed` with a
  code. It never throws a provider message.

## Storage

- S1. Drizzle tables live in `booking-providers/db.ts`, not in `server/modules/chatbot/db/`. The folder rules allow writes
  only inside this folder, so the file stays here. **REVIEW:** move it when the owner allows the write.
- S2. **No migration is written.** The SQL draft belongs in `db/migrations-draft/`, which this folder may not write. The
  unique keys to draft are:
  - `chatbot_external_bookings`: `(company_id, provider, external_booking_id)`
  - `chatbot_booking_reminder_sends`: `(company_id, appointment_id, channel)`
  - `chatbot_booking_attempts`: `(company_id, provider, idempotency_key)` (new)
  - `chatbot_calendar_secrets`: `(company_id, provider, purpose)` (new)
- S3. Every table has `company_id`. Every query builder puts `company_id` in its WHERE clause or insert values. The tests
  render the SQL and check this. **Not run against Postgres.** The harness has `pg-local.sh` and `apply-drafts.mjs` (updated 2026-11-09), and
  no draft has been written for this folder, so there was nothing to apply. **UNVERIFIED.**
- S4. The in-memory stores are the default for tests and local runs. Their rules match the Drizzle stores.
- S5. Links use `(company, provider, external id)`. A repeated insert returns the existing row.
- S6. **New.** `chatbot_booking_attempts.status` and `chatbot_calendar_secrets.purpose` have check constraints. Both
  have a company index. (UNVERIFIED against Postgres.)

## Not done

- No migration (S2). No Postgres run (S3). The `secrets/` implementation is not in this folder (F3).
- No webhook HTTP route (W3). No live provider calls. Everything in the tests uses the fake `HttpClient`.
- Telegram and web reminders (R5). Calendly event types that need a location (P6). Stale-pending sweep (B5).
- The integration wiring: nothing is mounted, and nothing is connected to the chatbot routes.
- Calendly `GET /users/me` (P3a) is unverified.
