# Inbox outbox foundation — Pass 20

This pass adds a **review-only** PostgreSQL outbox migration candidate. It is absent from the production migration inventory. A queued Inbox message can be enrolled exactly once per company/message by `enqueueQueued`; candidate rows have composite foreign keys to the existing Inbox message. Workers claim due jobs via `FOR UPDATE SKIP LOCKED` and conditional lease tokens, so an expired lease holder cannot mark a new lease complete. A failed send returns the job to retry with capped exponential backoff, or dead-letters after five claims.

The dispatcher requires a caller-injected provider transport; none is registered by default. Provider adapters must honour the stable `inbox:<company>:<message>` idempotency key for retries. Idempotency and provider reconciliation are contractual: an external provider without this capability cannot yet be enabled safely. The dispatcher deliberately does not mark Inbox messages delivered; the existing `queued` state remains authoritative for local approval/queueing, not remote delivery.

The disposable PostgreSQL CI job applies the Inbox candidate outbox table after original Inbox schema/RLS fixture; no live data is mutated. External sends remain disabled until security review, verified provider credentials, webhook signatures, reconciliation and migration deployment.
