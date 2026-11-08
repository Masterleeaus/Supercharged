# Events slice: decisions (2026-11-08)

Source ported: extensions/chatbot/System/Services/{WorkflowRuntime,StructuredActionRuntime,WebhookDispatcher,EventOutbox,EventOutboxProcessor,NotificationRuntime}.php, with the hardening migrations 2026_07_22_000003, 000006 and 000007.

## Workflows
- D1. Dispatch with an idempotency key returns the existing run. A unique index on (company_id, workflow, idempotency_key) backs it. The PHP also scoped by conversation_id; here conversation_id is stored but not part of the key. (UNVERIFIED against Postgres.)
- D2. Retry backoff is 30s * 2^(attempt-1), capped at 3600s, as in PHP. Max attempts is clamped to 1..25, default 3.
- D3. runStep records a completed step per (company, run, step key). A retried run reuses the stored output and does not call the function again. A step that throws is released, so the retry runs it.
- D4. The contract's "waiting" status is accepted by the schema but not used, as in the PHP.
- D5. claimNext is per company. The PHP worker claimed across all companies.

## Structured actions
- D6. Every kind has a typed argument schema (camelCase keys). Unknown keys are refused. The PHP stored any type and payload.
- D7. Kinds in REQUIRES_APPROVAL start "proposed". Other kinds start "approved" with no approver recorded.
- D8. The PHP "expired" status is not in the contract. An expired proposal is refused at approve time and stays "proposed". The PHP update was rolled back by its own exception, so the net effect matches.
- D9. Execution claims the action first, then runs the executor. A second caller gets "already executing" and the executor is not called twice. An executor error sets "failed" with a fixed message.
- D10. Buttons and forms the bot shows are validated on the server (validatePresentation). A response is checked against the same definition (validatePresentationResponse). The response is not stored by this slice.

## Outbox and webhooks
- D11. The contract's OutboxStorage is implemented on top of an extended store with lease fields (locked_at, locked_by) in place of the PHP "processing" status, which the contract does not name.
- D12. Realtime publish is recorded (realtime_published_at) before webhooks run, so a retry never publishes a realtime event twice. Only topics in INBOX_EVENT_TYPES go to the EventPublisher. Other topics go to webhooks only.
- D13. Webhook deliveries are tracked per (event, subscription). A later attempt skips subscriptions that already succeeded. The PHP resent to all subscriptions on every retry.
- D14. Attempts: 8 maximum, base 15s, cap 3600s, lease 300s, as in config. After the last attempt the event is "failed" and never sent again (dead letter).
- D15. Error text stored on a failed event is fixed text or a count. Response bodies and URLs are not stored.
- D16. Webhook body is {event, extension, payload, occurred_at}, payload carries event_uuid, same as PHP. Headers: X-Chatbot-Event, X-Chatbot-Signature (sha256=hex HMAC of the exact body), Idempotency-Key (the event id).
- D17. Signing secret is supplied by the caller (min 32, max 256 characters), sealed with SecretBox under company_id, and never returned. The PHP kept it in plain config.
- D18. A subscription whose secret cannot be opened gets no request (fails closed). The PHP would have sent an unsigned request.
- D19. Subscription URLs must be https with no credentials. The PHP did not check. No SSRF or DNS checks are done here; those belong to the HTTP layer.
- D20. The webhook flag CHATBOT_OUTBOUND_WEBHOOKS_ENABLED must be exactly "true". When off, no request is sent and events still publish realtime.
- D21. Only the transport kind (timeout or network) is kept for a transport error. The raw error message can echo the URL or the body.

## Notifications
- D22. The PHP fired an event with no sender. Here a NotificationSender is injected. Duplicate recipients are removed. Failures are counted and reported without the payload.

## Storage and migrations
- D23. Tables are chatbot_* in db/events.ts, with company_id on every table and composite keys. Draft SQL is db/migrations-draft/0301_events.sql. 0301 was chosen because 0002 is already used twice in that folder. The owner should renumber if needed.
- D24. The memory store is for tests and local runs. Every read and write is keyed by company_id.

## Contract change requests (not made, contracts are read-only here)
- C1. WorkflowRun: add maxAttempts and idempotencyKey. WorkflowDispatchOptions: add conversationId and maxAttempts.
- C2. StructuredAction: add expiresAt, presentation and idempotencyKey. StructuredActionStatus: decide whether "expired" exists.
- C3. OutboxStorage: claimBatch needs a lease (workerId, leaseSeconds). markFailed and markDeadLetter need an attempt count and a last-error field.
- C4. Realtime routing for outbox topics: name the topic-to-InboxEventType mapping in the contract.

## Events worker, webhook SSRF guard and dead-letter view (2026-11-09)

- W1. Webhook URLs must be https, on port 443 only, with no credentials. Public addresses only. The rule set is copied from knowledge/ssrf.ts into events/ssrf.ts (no cross-folder import). Webhook rules are stricter than knowledge: https only and port 443 only, where knowledge allows http and port 80.
- W2. The SSRF check runs at subscribe time and again before every request, including each redirect hop. A DNS lookup failure is a refusal (fails closed). A name that resolves to any private address is refused.
- W3. Redirects: 307 and 308 are followed (same method, same body, same signature), up to 3 hops. 301, 302 and 303 are not followed and the delivery fails with "Redirect not followed." Other 3xx codes count as a non-2xx failure, as before.
- W4. Refusal messages stored on a delivery are fixed text: "Address refused.", "Redirect target refused.". The URL is never stored.
- W5. The resolver is injected as the optional last argument of createWebhookSubscriptionService and as deps.resolve on createWebhookDispatcher. The default is the system resolver (node:dns). Tests pass a fake, so no test does DNS.
- W6. Existing tests/modules/chatbot-events.test.mjs now inject a fake resolver (93.184.216.34 for hooks.example.test). Without it, the old suite would perform real DNS. Its 28 tests still pass.
- W7. Known limit: the SSRF check resolves the name, then the HttpClient resolves it again to connect. A DNS rebinding answer between the two can still reach a private address. The HTTP layer should connect to the address that was checked, or refuse hosts that changed. This is a change request for the HTTP layer owner (C5 below).
- W8. The outbox batch is createOutboxProcessor(...).process(companyId, options). It runs one batch and returns counts. A scheduler calls it in a loop and stops when claimed is 0. No new worker type was added.
- W9. Each claim gets its own lease owner: "<workerId>/<claim token>" (stored in locked_by). Every write after the claim (realtime mark, published, failed, dead-letter) is fenced on that owner. A worker whose lease expired and was taken over gets false from the write and stops. Its publish is not counted, and its webhooks stop at the failed realtime mark.
- W10. Lease length stays 300 seconds. A batch must finish inside the lease. The fence stops stale writes, but a stale worker can still send one webhook it had already started (at-least-once, with the same Idempotency-Key). The realtime publish is not fenced before the call, so a rare duplicate realtime event is possible in that same window.
- W11. OutboxStore write methods now return a boolean (true when the row was written). markRealtimePublished, markPublished, markFailed and markDeadLetter take an optional leaseOwner. Callers that pass none are unfenced, as before.
- W12. OutboxRecord carries failedAt, so a dead-letter entry has a time to sort by.
- W13. Dead-letter view: createDeadLetterView(store).list(companyId, { limit }). Newest failure first. Limit is clamped to 1..200 with a default of 50. It leaves out payloads and lease owners, because payloads can carry customer data. Every row is checked for company_id twice: in the query and in the view.
- W14. Drizzle: outboxDeadLetterQuery filters on company_id and status "failed". Claims keep SELECT ... FOR UPDATE SKIP LOCKED inside the transaction. (UNVERIFIED against Postgres.)
- W15. Tests: new file tests/modules/chatbot-events-worker.test.mjs, 13 tests, all pass. The name is a separate file so the existing chatbot-events.test.mjs stays as it was apart from W6.
- W16. Type check: narrow strict tsc on the events files only, in /home/claude/integration-scratch/events-worker-tsc. No errors in the new code. Drizzle is not installed on this machine, so drizzle-store.ts shows only environmental TS2307/TS7006 errors. One error predates this pass: types.ts ActionRecord extends StructuredAction (TS2430). workflow-runtime.ts has the same class of error.

Contract change request (not made):
- C5. HttpClient (contracts/http.ts): state that the client follows no redirects, and that it connects to the address the caller checked (or accepts a pinned address). This closes the DNS rebinding gap in W7. Owner: the contracts agent, with the HTTP layer owner.
