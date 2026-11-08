# Voice calls (phone): decisions

Source: `extensions/chatbot-voice-call/` (PHP). The PHP extension is a browser voice widget (OpenAI Realtime or ElevenLabs), not a telephony integration. It has no phone numbers and no webhooks. The phone-call design below follows the brief and the `CallProvider` contract. Provider implementations are injected. None is named here. DRAFT. Unverified against Postgres.

## Ported from the PHP

- Start checks: chatbot enabled, plan voice seconds limit (0 refuses, positive is a monthly cap), monthly usage window, and a session row per call. PHP `VoiceCallController::start` and `end`.
- Per-call duration on the row (`duration_seconds`). PHP wrote it on a history row.

## Not ported (open)

- N-1: Browser realtime credentials (OpenAI ephemeral key, ElevenLabs agent and signed URL). Belongs to the `voice/` owner, not to telephony.
- N-2: Demo-mode daily seconds limit (`voice_call_demo_seconds_limit`, HTTP 429). Demo mode is an app setting outside this contract.
- N-3: Transcript storage (`voice-transcript-*` history rows). Transcript text is still not stored. Credit deduction is ported, see the completion pass below.
- N-4: Settings page and voice-call-scripts view. Out of scope for the service.
- N-5: No route and no wiring into `chatbot-routes.ts`. Owner step after integration. A worker must call `sweepCallLimits` (scheduler.ts) on a timer, because calls with no provider events are otherwise only capped at the next webhook.

## Completion pass (owner credit, quota sweep, in-memory provider)

Files: `voice-call/provider-memory.ts` (new), `voice-call/scheduler.ts` (new), `voice-call/service.ts`, `voice-call/ports.ts`, `voice-call/storage-memory.ts`, `voice-call/storage-drizzle.ts`. Tests: `tests/modules/chatbot-voice-completion.test.mjs`. The existing `chatbot-voice-call.test.mjs` harness now passes an always-funded `credits` fake.

- **Credit is ported from the PHP.** `VoiceCallController::start` checks the owner's credit balance and returns 403 "Insufficient credits for voice call." when there is none. `::end` charges the owner for the transcripts. Here the check runs at the start of every outbound or inbound call, after the plan and quota checks, and a balance check that throws also refuses the call.
- **Transcripts are charged on arrival, not once at call end.** Transcript text is not stored, so the charge is made per `call.transcript` event for a ringing or in-progress call. A charge after the call has ended is ignored. The ledger receives an idempotency key built from the body hash and the event index, so a redelivered webhook does not charge twice.
- **A failed charge refuses the webhook with 503** ("Credit could not be recorded"), so the provider retries. Transcript text is never logged.
- **`CreditLedger` is a required dependency.** It lives in `ports.ts`. The owner's billing layer implements it. This folder does not decide prices.
- **The `CallProvider` interface is not added again.** It already exists in `contracts/voice.ts`, and the service takes it as an injected dependency. `provider-memory.ts` is the in-memory implementation. It makes no network call, verifies signatures with the same HMAC rule as production, and reads a JSON wire format.
- **Quota sweep is `enforceLimitsForCompany(companyId, { limit })`** on the service, and `sweepCallLimits(service, companyIds, { limit })` in `scheduler.ts`. Each company is swept in its own call. One company that fails is reported as "sweep failed" and the sweep goes on. Only `in_progress` calls past their cap are ended. Ringing calls have no start time yet.
- **The sweep is not gated by the flag,** the same as ending a session. A call past its cap must still be ended when voice is off. The existing per-chatbot `enforceLimits` is still gated, and is unchanged.
- **Call duration per call** was already stored (`duration_seconds`, computed from server timestamps and capped). Covered by the existing tests, no change.

### Change requests (outside this folder)

- `db/voice-call.ts` and the draft SQL: an index on `(company_id, status, started_at)` for the company-wide sweep query. The current index starts with `chatbot_id`, so the sweep scans.
- Owner step: the `CreditLedger` implementation, and the scheduler's timer.

## Deviations (behaviour changes)

- D-1 Webhook verification. PHP `verifyWebhook` returns `true` for every request. Here it fails closed: missing credentials, missing or stale timestamp (300 s window), or any provider verdict other than `true` is a 401 with no state change. `verifySignedWebhook` (HMAC-SHA256 over `timestamp.rawBody`, constant-time compare) is provided for adapters.
- D-2 Duration. PHP trusts the client `duration` on `/end`. Here duration is computed from server timestamps and capped at the plan cap stored on the row.
- D-3 Plan limit values. PHP treats any negative value as unlimited. Here only -1 is unlimited. Any other negative or non-integer value fails closed as "not in plan".
- D-4 Quota window. PHP uses the app timezone for start of month. Here it is UTC.
- D-5 Concurrency. The quota also reserves the cap of every ringing or in-progress call, so two concurrent starts cannot overrun the plan.
- D-6 Duration cap. A call that reaches its cap is hung up through the provider, then closed with `end_reason = limit_reached` and duration equal to the cap. The row is closed even when the provider does not confirm the hang-up.
- D-7 Status. `no_answer` exists in the contract but no webhook event maps to it. A `call.failed` event sets `failed`.
- D-8 Phone numbers. Stored in full on the row, because the provider needs them. Every output carries the masked form in `CallSession.fromNumber` and `toNumber`, which keeps only the last four digits. Logs drop raw bodies, credentials and signatures, and mask phone-like text in every message and field.
- D-9 Callback URL. Must be https, on an allow-listed host, and its path must contain the company id and the chatbot id. Otherwise 400.
- D-10 Provider session binding. A provider session whose company or chatbot differs from the request is not hung up, because its call id may belong to another tenant. The row is closed as `failed` with `provider_error`.
- D-11 Inbound calls. `CallProviderEvent` carries no numbers, so an inbound call is recorded through `startInbound`, which takes the verified request plus numbers extracted by the adapter. An unknown call in a webhook is refused and never created.
- D-12 Webhook batches. If any event refers to a call outside this company and chatbot, the whole request is refused with no writes.
- D-13 Idempotency. A replayed start with the same key returns the existing call and places no second call.
- D-14 Migration number. `0030_voice_call.sql` is provisional. Renumber at promotion.
- D-15 Foreign key. Composite `(company_id, chatbot_id)` to `chatbots (company_id, id)`, as in the customers slice.

## Tests

`tests/modules/chatbot-voice-call.test.mjs`: 39 tests, all passing. Scoped strict type check of the six source files passes (`/home/claude/voice-call-tc/tsconfig.json`).
