# Titan Field + Titan Desk — Pass 8 source integration

## What is newly integrated

Desk:
- `server/integrations/titan-field/reply-protocol.mjs`: versioned strict, signed, PII-free Desk->Field proposal wire (identical Field copy)
- `reply-capture.mjs`: verified-provider input -> trusted company binding -> allowlisted suggested action -> preview or signed handoff
- `reply-sender.mjs`: local/HTTPS-only transport, restricted endpoint, correlated nonexecuting receipt validation
- `reply-batch.mjs`: capped sequential preview/shadow orchestration; duplicate suppression and PII-free activity summaries
- `bridge-readiness.mjs`: safe bool-only readiness snapshot with no secret exposure

Field:
- `apps/web/lib/titan/desk-bridge/reply-protocol.mjs`: byte-identical transport module
- `reply-policy.mjs`: deterministic human-review action mapping, zero execution authority
- `reply-receiver.mjs`: signature/tenant/resource/ledger verification -> durable proposal receipt only
- `reply-projection.mjs`: safe activity display projection, never changes operations state
- `app/api/v1/titan/desk-bridge/reply-proposals/route.ts`: bounded-body Node Next API adapter, fail closed until DB agent supplies ports

The existing Field->Desk outbound bridge from Pass 3-7 is preserved **without changes**. The existing Desk voice/CRM/email and Field job/quote/payment modules are also preserved unchanged.

## Explicit non-goals

- No real SMS, email or voice calls; no provider routing has been connected.
- No automatic bookings or customer updates; proposed actions require human/governed approval.
- No database access, schema changes, migrations, account mappings, ledger implementations, or durable queue execution. These belong to the DB integration agent.
- No full GitHub repository checkout: this Field archive remains the verified cumulative source overlay and protected conflicts from Pass 7, plus the 5 Pass 8 Field source files. Do not deploy the overlay as a complete app.
- The Desk backup still lacks certain original deployment/config files. Do not deploy it directly over production.

## Enablement status

- Desk outbound Field->Desk route: original `TITAN_FIELD_BRIDGE_MODE=shadow` flag, fails closed without ports.
- Field inbound Desk->Field route: `TITAN_DESK_REPLY_SHADOW_MODE=1` flag, **still fails closed** because ports are deliberately unconfigured in this pass.
- Desk reverse transport: no webhook registration, no automatic jobs, and no route registration; callable only by a future verified provider adapter and policy owner.
- No mode allows real delivery or direct Field state mutation.

## Regression

- Pass 3–7 suite retained unchanged: 75 tests.
- Pass 8 reverse bridge suite: 33 tests.
- Combined: 108 tests. Test output is included in package audit.
- One test uses real localhost HTTP sockets and injected in-memory ledger ports; **not** a production integration.
