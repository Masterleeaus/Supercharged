# Booking HTTP layer: decisions

Slice: `server/modules/chatbot/booking-routes/`. Test: `tests/modules/chatbot-booking-routes.test.mjs`.

## What the PHP source actually contains

- `extensions/chatbot-booking/System/Http/Controllers/ChatbotBookingController.php` has one method, `index`, which returns a view. It has **no** list, create, update or cancel endpoints. The CRUD routes in this slice are new, shaped to match the Desk chatbot router.
- Booking data lives in `System/Models/Appointment.php` (table `ext_chatbot_appointments`: `calendar_id`, `starts_at`, `ends_at`, `status`, `metadata`) and `System/Services/BookingRuntime.php` (`available`, `book`, `waitlist`). Statuses seen: `waitlisted` (from `waitlist()`) and `cancelled` (excluded from busy windows). The PHP default status is `confirmed`, per `extensions/chatbot-booking/database/migrations/2026_07_21_040001_upgrade_generic_booking_runtime.php`. The earlier note that PHP uses `booked` was wrong and is corrected here (fix pass 2026-11-08, H2). The wire shape here follows that model.
- Booking-assistant settings in PHP are fields on the chatbot record: `is_booking_assistant`, `booking_assistant_conditions` (array), `booking_assistant_iframe`, read by `chatbot/System/Http/Controllers/Api/ChatbotApplicationController.php` and the chatbot Store, Update and Customize requests. The one company-level setting is `calendly_access_token` in `resources/views/setting.blade.php`. The form posts to `dashboard.admin.settings.chatbot.booking.update`, but that handler is not in the extension source.
- `System/Support/FeatureFlags.php` reads `config('chatbot-booking.feature_flags.*')`. Nothing in the Desk server module tree uses a PHP-style flag. See the flag section below.

## Existing Desk booking code (found, not duplicated)

- `server/modules/booking-agent/` is the Desk port of the PhoneCallAgent booking tools. It has `ports.ts` (`BookingCalendar`, `BookingStore`) and `schemas.ts` (`slot`, `name`, `email`, `timezone`, `phone`). Its `PORT-MAP.md` lists the gaps: no `company_id` on `appointments`, no provider UID column, and no approval resume. **This slice does not import it.** The two wire shapes differ, see decision 2.
- `shared/schema.ts` `appointments` (line 1602) already has a nullable `company_id`. It uses `appointment_date`, `appointment_time`, `duration`, `contact_*` and status `scheduled`. `appointment_settings` is at line 1638 (not read in full here). The `appointments` row is keyed by `user_id`, with `company_id` as an extra nullable column. The bookings agent owns the mapping.
- `server/modules/widget/public-widget-routes.ts` (around lines 1290 to 1320) has the duration-aware overlap rule. The service contract below requires the same rule (`[start, end)` overlap, cancelled rows excluded).
- `tests/security/appointment-secret-fail-closed.test.mjs` covers the appointment **webhook** secret. These routes are session-authenticated, not webhook-driven, so no secret is needed here.

No Drizzle table is needed in this slice, so there is no `schema.DRAFT.ts`. The bookings agent owns the storage table.

## Feature flag

- `ENABLE_CHATBOT_BOOKING_ROUTES`. Only the literal `"true"` turns it on. It follows the env pattern in `server/infrastructure/bullmq/index.ts` (`process.env.ENABLE_BULLMQ === 'true'`).
- Off by default. When off, `createBookingRouter` returns a router that answers 404 to everything, and the auth middleware never runs.
- The integration agent should mount the router only if it wants the flag checked at mount time too. The router checks it itself as well.

## Contract assumed from the bookings module

Defined in `contract.ts`. The router depends only on `BookingService`. `BookingStorage` is listed because the service is expected to sit on it, and the test fakes implement it.

- `BookingService` methods, all `companyId` first: `listBookings`, `getBooking`, `createBooking`, `updateBooking`, `cancelBooking(companyId, id, reason)`, `getAssistantSettings`, `updateAssistantSettings`.
- `getBooking`, `updateBooking` and `cancelBooking` return `null` for a row that exists under another company. The router turns null into 404, so a cross-company id looks like a missing one.
- Rule errors are thrown as any object with a numeric `status` (400 to 499) and a `message`. The router duck-types them, so the bookings module's own error class works without an import. An overlap should throw 409 with `Slot already booked`.
- `BookingStorage` methods: `listBookings`, `getBooking`, `insertBooking`, `updateBooking`, `findOverlapping`, `getAssistantSettings`, `saveAssistantSettings`. Each takes `companyId` first.

## Routes

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/bookings` | read | Query: `calendar_id`, `status`, `from`, `to`, `limit`, `offset`. Returns `{ data, limit, offset }`. |
| POST | `/bookings` | write | Body: `calendarId`, `startsAt`, `endsAt`, optional `status` (`confirmed` or `waitlisted`, default `confirmed`), `metadata`. 201. |
| GET | `/bookings/:id` | read | 404 when missing or another company's. |
| PATCH | `/bookings/:id` | write | Times, `status` (`confirmed` or `waitlisted` only), `metadata`. At least one field. |
| POST | `/bookings/:id/cancel` | write | Optional `reason`. 200 with the cancelled booking. |
| GET | `/booking-settings` | settings | Returns `hasCalendlyToken` (boolean) and `bookingAssistantConditions`. The token is stripped by the router, whatever the service returns. |
| PATCH | `/booking-settings` | settings | `calendlyAccessToken` (string or null to clear), `bookingAssistantConditions`. |

Order inside each route: authenticate (401), company scope (403), role (403), JSON body (16 kB limit), then the handler.

## Decisions for the owner's review

1. **Role sets.** Reads and writes allow `admin`, `manager`, `agent`. Settings allow `admin`, `manager`. These are my choices, not taken from PHP (PHP has no booking routes). Without a supplied `requireRole` the router now refuses every request with 403 (fix pass 2026-11-08, M5).
2. **Wire shape.** This slice uses the PHP `Appointment` shape (`calendarId`, `startsAt`, `endsAt`, `status` of `booked`, `waitlisted` or `cancelled`, `metadata`). `booking-agent` uses `slot`, `name`, `email`, `timezone`. The two need reconciling before merge. My guess is the bookings module maps both.
3. **Cancel is its own endpoint.** `PATCH` cannot set `cancelled`, so cancelling always goes through the cancel route and its reason is recorded.
4. **Overlap is a service rule.** PHP has none and relies on the provider. Desk's store must not rely on that (per `PORT-MAP.md`), so the 409 check is part of the contract.
5. **Strict input.** A `companyId` in the body or query returns 400. It is not silently dropped. The brief asked that the body cannot override tenancy, and this is the strongest way to show it.
6. **Calendly token is write-only.** The GET never returns it, and PATCH responses never echo it. The router removes `calendlyAccessToken` from whatever the service returns and reports `hasCalendlyToken` instead (fix pass 2026-11-08, H3; the old field `calendlyAccessTokenSet` is no longer sent). Storage holds it in plaintext in this contract. **Still open, owner decision:** encryption at rest for the token. Not changed in the fix pass.
7. **Booking-assistant settings scope.** The endpoint carries company-level settings only: the Calendly token and the conditions list. `is_booking_assistant` and `booking_assistant_iframe` stay on the chatbot record, which belongs to the chatbot module. `booking_assistant_conditions` is assumed to be a `string[]`. The PHP only reads it as a truthy array, so its shape is unverified.
8. **Metadata.** Free-form JSON, capped at 8 kB serialised. PHP has `metadata` as an array cast, so this matches.

## Not ported

- **Calendly and Cal.com provider calls.** External, out of scope. The token is stored but nothing calls Calendly.
- **Availability endpoint.** `BookingRuntime::available()` (busy windows for a calendar) is read-only and not in the brief. It could be added as `GET /bookings/availability`.
- **Settings update handler.** The PHP form action has no handler in the extension, so the save behaviour here is new.
- **Logging, metrics, webhook dispatch, health checks.** Out of scope per the brief (`config/platform-quality.php`).
- **Blade views and iframe.** UI, not HTTP API.

## Verification

- `tests/modules/chatbot-booking-routes.test.mjs`: 21 tests, 21 passing. They cover the required cases: unauthenticated rejected (GET and POST), body cannot override `companyId`, validation returns 400, cross-company id returns 404 (get, update, cancel), successful create and cancel, plus the flag, company scope, overlap 409, settings token handling and role.
- Type-check of the three source files with `tsc --strict` (scratch config, outside the repo): clean.
- **Environment note.** The Desk checkout has no `node_modules`, so `express` and `zod` do not resolve. I ran the tests with the two packages installed in `/tmp/booking-routes-deps` and a preload resolver hook in `/tmp/booking-routes-scratch/hook.mjs`. Neither lives in the repo. After `npm install`, the brief's command should run as is.
