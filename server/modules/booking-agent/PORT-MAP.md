# Booking agent: port map

Source: `Clean-Hub/app/Extensions/PhoneCallAgent/System/Booking/` (PHP).
Target: `server/modules/booking-agent/` (TypeScript, Desk).

## What was ported

| PHP source | Desk module |
| --- | --- |
| `BookingToolDefinitions::definitions()` (create, cancel, reschedule) | `tools.ts`, `schemas.ts` |
| `BookingToolHandler::handle()` and the three handlers | `dispatcher.ts` |
| `Contracts/BookingProviderInterface` | `ports.ts` (`BookingCalendar`) |
| `Providers/CalComBookingProvider`, `CalendlyBookingProvider` | not ported. Needs a Desk adapter (see below) |
| Local storage | none in PHP (the provider is the source of truth). `ports.ts` (`BookingStore`) is new |

`check_availability` is not ported. It is read-only and does not book, so it can stay outside the gate. Decide whether to add it.

## Existing Desk code to reuse

| Desk code | Use it for | Gap |
| --- | --- | --- |
| `shared/schema.ts` `appointments` (line ~1485) | Backing table for `BookingStore` | Keyed by `userId`, not `companyId`. `contactPhone` is NOT NULL (PHP phone is optional). No column for a provider booking UID (only `googleCalendarEventId`). Needs `company_id`, `provider_booking_uid`, and a nullable phone. Schema change not made here (forbidden file). |
| `shared/schema.ts` `appointmentSettings` (line ~1517) | `allowOverlapping` flag for the conflict rule | Settings are keyed by `userId`. Needs the same company mapping. |
| `server/services/openai-voice-agent/hydrator.ts` `createAppointmentHandler` (~lines 400-431) | Overlap rule: reject a same date and time when `allowOverlapping` is false, and the duplicate-by-contact check | Matches on exact date and time only. The widget (`public-widget-routes.ts` ~1300-1310) uses a duration-aware overlap test, which is the better rule to copy. |
| `server/modules/widget/public-widget-routes.ts` ~1290-1320 | Duration-aware overlap formula (start < existing end and end > existing start, default 30 min) | Reads `userId`, not `companyId`. |
| `server/services/google-calendar/google-calendar.service.ts` `createCalendarEvent`, `updateCalendarEvent`, `deleteCalendarEvent` | Calendar mirror for a Desk-owned calendar (the nearest thing to create, update and cancel) | Not a booking provider. Keyed by `userId`. Takes `CalendarAppointment` shape. |

Existing Desk writers of `appointments` that do NOT call the approvals gate (`grep gateAction` finds no caller outside the new module):
- `server/routes/webhook-routes.ts` ~5509 (`handleAppointmentToolWebhook`, the ElevenLabs tool webhook)
- `server/services/openai-voice-agent/hydrator.ts` ~436
- `server/engines/twilio-openai/services/openai-agent-factory.ts` ~435
- `server/engines/plivo/services/openai-agent-factory.ts` ~435 and ~1142
- `server/routes/flow-automation-routes.ts` ~3386 and ~3961
- `server/modules/widget/public-widget-routes.ts` ~1322

These are ungated booking actions in Desk today. The main session should decide whether to route them through this module.

## Functions to add

1. `DeskBookingStore implements BookingStore`: reads and writes `appointments` scoped by `company_id`.
2. `DeskBookingCalendar implements BookingCalendar`: a port of the Cal.com and Calendly providers (HTTP, per-company API key). Keep the PHP request shapes. Nothing in Desk has one yet.
3. Conflict check: `findOverlappingScheduled(companyId, start, end)` on the store, used by `DeskBookingCalendar.createBooking` and `rescheduleBooking` before the provider call. The PHP source has no conflict check; it relies on the provider. Desk's own store must not rely on that.
4. Approval resume: when a gate returns `pending`, a trusted executor must run the approved action later. It must re-read the approval row, check `status === 'approved'`, `companyId`, `action` and params match, call `ApprovalService.markExecuted`, and then call the dispatcher's execution step. The dispatcher has no resume path yet.
5. `BookingGate` adapter: pass a real `ApprovalService` instance. Its `gateAction` result is structurally compatible with `BookingGateResult`. This was not compiled against the real class.
6. Timezone conversion: `slot` is ISO 8601 with an offset. `appointments` stores a local `date` and `time`. Convert in the store adapter using the caller `timezone`.
7. Verified `companyId` from the session or agent runtime, passed into `dispatch()`. Never read from a request body or tool input.

## Behaviour changes from PHP (decided, review)

- `timezone` is required (the PHP definition lists it as required, but the handler defaulted to `UTC`).
- Reschedule with no new UID returns a failure. The PHP handler said "rescheduled successfully" in that case.
- `slot` and `new_slot` must be ISO 8601 with an offset or `Z`. PHP accepted anything Carbon could parse.
- Phone must be E.164 when given. Empty phone is treated as absent.
- Unknown keys (including `companyId`) are rejected, not ignored.
- The PHP logs wrote caller name, email and full input. The port logs nothing.
- Failure messages on create, cancel and reschedule are the PHP strings, because the voice agent reads them.

## Still missing before real bookings

- The `appointments` schema change, and a migration. Not run here.
- Desk provider adapters (Cal.com, Calendly) or a decision to use the Google Calendar service.
- Approval resume executor (item 4 above).
- A reconciliation step if the provider books but the local store write fails. The dispatcher currently propagates that error as a `failed` outcome, which would be wrong because the booking exists.
- Installed dependencies: `zod` is not in `node_modules` in this checkout, so the test command fails until `npm install` runs.
