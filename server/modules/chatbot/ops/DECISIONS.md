# Ops slice: attachments, analytics, export, health: decisions

Port of `AttachmentRuntime`, `ChatbotAnalyticsService`, `ConversationExportService`, `HealthCheckService` and the
metrics helper from the Commerce Crew chatbot extension. Recorded 2026-11-08.
Tests: `tests/modules/chatbot-ops.test.mjs`, 32 of 32 pass. Scoped strict type check: 0 errors.

## Deviations from the PHP (behaviour changes)

1. **Declared type is checked against the bytes.** The PHP trusted the detected MIME. Binary types must match a
   known signature. Text types must have no NUL byte in the first 8 KiB and must decode as UTF-8.
2. **Blocked extensions are checked on every dot segment.** `invoice.php.png` is refused. The PHP checked only the last extension.
3. **Storage key is `chatbot/attachments/<companyId>/<randomUUID>`.** No extension and no filename. The PHP used Laravel's
   random name, which is also safe, but the company prefix is new.
4. **Downloads use an HMAC link.** The PHP had no signed link. The link carries an expiry and a signature over
   company, id and expiry. Verification uses a constant-time compare, and also checks that the row belongs to the company.
   TTL is capped at 15 minutes. The signing key must be at least 32 characters, or construction throws.
5. **No dedupe by hash.** The PHP reused an existing row with the same hash in the same conversation. The contract's
   `put` takes no conversation id, so dedupe is dropped. Each upload is stored.
6. **Health report carries no exception text.** The PHP put `$exception->getMessage()` in the report, and that text can hold a
   connection string. The port returns the fixed code `database_unreachable`. Failing schema probes count as missing.
7. **Health tables use Desk names.** `chatbot_conversations`, `chatbot_messages`, `chatbot_attachments`, plus
   two columns. The PHP `ext_chatbot_*` list is not ported, because those tables do not exist in the Desk.
8. **CSV formula guard.** Cells starting with `= + - @`, tab or CR get a leading apostrophe. The PHP did not.
9. **Export file name uses `[A-Za-z0-9_-]` only.** Other characters become `_`.
10. **Analytics `resolved_by_ai` is new.** It counts conversations created in the range that were never handed to a
    human (`connect_agent_at` null) and are closed. The PHP had no such metric.
11. **Analytics range is `[from, to)`, capped at 366 days.** Top lists cap at 10.
12. **Analytics first response reads only messages inside the range.** A handoff whose reply lands after `to` is not counted.
13. **Top lists return chatbot ids, not titles.** The PHP joined the chatbot title. The caller can join it.
14. **Bookings and orders counts are optional.** They come from an injected list of dates. The Drizzle source does not
    read the bookings or orders tables. The metrics are left out for channel or chatbot grouping, and for a single-chatbot filter.
15. **Metrics tags are allow-listed.** Only `outcome`, `format`, `kind`, `status_class`, with values of `[a-z0-9_]{1,32}`.
    Anything else is dropped. The PHP sent events to Laravel's event bus, which this port does not use.
16. **Health `runtime_enabled` is passed in.** The PHP read `chatbot.runtime.enabled`, default true. The Desk has no such
    flag, so the caller decides. The default in this port is the caller's, not true.

## Decisions taken without an owner answer

- Attachments are not tied to a conversation, because the contract has no conversation field. Add it later if
  the inbox needs to list files per thread.
- Analytics sources and export readers are injected, so the aggregation has no dependency on Drizzle.
- Metadata table is `chatbot_attachments` with primary key `(company_id, id)`, and migration draft `0090_ops.sql`. The number was
  picked to avoid other slices. Owner to renumber on promotion.
- Export uses the `chatbot_messages.message` column, and excludes `is_internal_note = true` in SQL and again in code.

## Not ported

- PDF export. Returns 501 with `not_implemented`, as in `chatbot-service.ts`.
- Quarantine (`quarantine()` and its status). The contract `AttachmentStore` has no such method.
- `ExtensionLogger` and `FeatureFlags`. Logging is left to the app logger, and flags use `readFlag`.
- `ExtensionHealthService`. It is the smaller version of the health report, so one report covers both.
- A real blob store. The port needs an object-store adapter, and the owner chooses it. This module writes no local files.

## Change requests against contracts/ (not edited here)

- `contracts/flags.ts`: add `ATTACHMENTS_ENABLED` and `ANALYTICS_EXPORT_ENABLED` to `CONTRACT_FLAGS`, so routes can gate
  uploads and export with `readFlag`. Today nothing in this slice is flag-gated.
- `contracts/runtime.ts`: document that `AnalyticsQuery.to` is exclusive. The code assumes this.

## Owner decisions still open

- Which object store holds the bytes, and whether signed links point at it directly or go through the route (this port uses the route).
- The signing key source. The caller reads `CHATBOT_SECRET_KEY` from the environment and passes it in. The key is not stored.

## Gap pass (2026-11-09): bookings and orders counts, company-tagged rows

Tests: `tests/modules/chatbot-ops-content-admin.test.mjs`, 16 of 16 pass. `chatbot-ops.test.mjs` still 32 of 32.
Scoped strict type check (`/home/claude/integration-scratch/ops-content-tc`): 0 errors.

1. **Bookings count = confirmed appointments created in the range.** Waitlisted and cancelled rows are not counted.
2. **Orders count = orders placed in the range (`placed_at`), cancelled excluded.**
3. **Read path is ops-owned, read only.** The bookings and orders Drizzle adapters have no company-wide, date-ranged
   read, so `buildLoadBookingRows` and `buildLoadOrderRows` in `ops/drizzle-storage.ts` read `chatbot_appointments` and
   `chatbot_commerce_orders` with `company_id` in the WHERE. The slice files are not touched.
4. **Company-tagged rows.** `AnalyticsWindow` gains `bookingRows` and `orderRows`. The aggregation drops any row whose
   `companyId` differs from the argument. The older plain `bookingsCreatedAt` and `ordersPlacedAt` arrays are kept for
   the existing tests and are trusted as already filtered.
5. **Analytics metrics.** The contract lists `resolved_by_ai`, `bookings_created` and `orders_placed`. `agent_replies`
   is not in the contract yet, so the code does not use it. Code follows the contract when it lands.

Change requests against `contracts/` (not edited here):
- `contracts/runtime.ts`: add `"agent_replies"` to `ANALYTICS_METRICS` (still open from the first pass).
