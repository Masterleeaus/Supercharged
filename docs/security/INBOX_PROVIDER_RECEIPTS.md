# Signed provider delivery receipts — Pass 21

Pass 21 introduces an **unmounted** generic callback router. It is suitable only for an integration gateway that explicitly implements the documented `x-inbox-timestamp` and `x-inbox-signature: sha256=<hex>` contract, calculated over exact `<unix-seconds>.<raw-body>` bytes with a server-managed secret of at least 32 characters. Timestamp drift is limited to five minutes; signatures use constant-time comparison.

The HTTP path uses an opaque integration identifier resolved server-side to company, provider and secret. Callbacks cannot choose their company through the JSON payload, headers or query string. The JSON event body carries `eventId`, `providerId`, `outcome` (delivered/failed), and optional `occurredAt`. Only events matching a previously acknowledged, company-scoped outbox provider ID are persisted. Immutable receipts deduplicate per (company, provider, event ID); unknown references are recorded as unmatched outcomes, not applied to another company.

The SQL table is a **review-only migration candidate**, not deployed to production. No secrets are committed, no callback router is registered, and no provider sender is configured. Specific providers require separate signature and payload adapters. Delivery events are evidence; do not infer remote delivery from a queued Inbox message or successful local dispatch alone.
