# Supercharged — AI workforce and communications architecture

**Scope and acceptance guide, 18 November 2026.** This documents required controls and the existing product direction; it does not certify agents, provider integrations or production deployment. Read [root README](../README.md), [modes](modes/README.md), [status](../STATUS.md) and [Central integration handbook](https://github.com/Masterleeaus/Central/blob/main/docs/INTEGRATION_HANDBOOK.md).

## Purpose and product boundary

Supercharged owns tenant-scoped customer communications, inbox, voice/messaging adapters, campaigns, agent orchestration, governed tool execution and connector workflows. It does **not** become a second booking, invoicing, identity or competency authority. Central supplies verified identity, entitlements and company context; Scheduled commits bookings; Sorted owns jobs/quotes/invoices; Skilled owns assessed competencies. The WordPress Front Desk plugin is a customer interface, not a second installed Pro/AI plugin.

## Agent execution contract

1. **Trigger:** inbound message, voice event, approved workflow, schedule or human instruction, with recorded origin and consent.
2. **Context:** verified Central company UUID, caller identity, roles, entitlement, purpose and bounded knowledge sources; reject untrusted tenant IDs and prompt-injected tool instructions.
3. **Plan:** model can classify, draft or recommend actions. The plan itself has no authority to mutate business records.
4. **Policy:** deterministic engine checks tool allowlist, arguments/schema, risk level, company/object scope, consent, spending/calling limits and human approval requirements.
5. **Execute:** approved tool invokes the **owning service's** authenticated API, not a direct cross-product database write; mutating calls carry idempotency keys.
6. **Receipt:** store outcome, correlation, redacted audit trail, retries and errors; communicate pending/failed/completed truthfully.
7. **Recovery:** timeout, duplicate provider webhook, revoked authorization, human takeover and provider outage must fail closed or reconcile safely.

## Customer communication requirements

- Unified inbox and conversation history with company scoping, participant identity, assignment and handoff.
- Consent and suppression for marketing; provider-specific call/SMS/email rules, opt-out and retention controls.
- Signed or otherwise strongly authenticated webhooks, raw-body validation where required, replay protection, URL allowlists for remote media and secrets rotation.
- Voice agent tools cannot place calls, charge, reschedule or modify bookings without explicit deterministic authorization and verified customer/company scope.
- Provider adapters must report real availability and failures; a configured adapter or UI alone does not establish successful end-to-end operation.

## Connector lifecycle

Discover manifest → verify licensing/provenance → register allowed capabilities → company-scoped OAuth/secret provisioning → test least-privilege API access → initial sync → incremental replay/idempotency → revocation and credential rotation → audit and deprovision. No connector should create a parallel source of truth for Scheduled or Sorted data.

## Validation matrix

| Area | Minimum evidence |
| --- | --- |
| Agent tools | Schema validation, allowlist, authorization, approval, idempotency and audit tests |
| Identity | Cross-company denial, revoked access, expired entitlements, service-audience checks |
| Voice | Real sandbox call/webhook, signature verification, replay and outage tests |
| Messaging | Consent, suppression, opt-out, delivery receipts and retry behaviour |
| Booking | AI request invokes Scheduled authoritative API; conflict and timeout recovery |
| Integrations | Per-company credential isolation, rotation, webhook replay and provider sandbox |
| Operations | Observability, rate/abuse controls, redaction, rollback and escalation |

## Current evidence and unresolved work

The inherited codebase and historical held patches contain proposed fixes and draft migrations. A patch README is not proof that the patch was merged or deployed. In particular, review the [play-audio webhook authentication design](pending/held-patches/04-play-audio-hmac/README.md) before any provider rollout; it describes an unresolved signing capability mismatch. Track actual acceptance in [Supercharged issues](https://github.com/Masterleeaus/Supercharged/issues?q=is%3Aissue+is%3Aopen), including [#317](https://github.com/Masterleeaus/Supercharged/issues/317), [#318](https://github.com/Masterleeaus/Supercharged/issues/318), [#349](https://github.com/Masterleeaus/Supercharged/issues/349) and [#364](https://github.com/Masterleeaus/Supercharged/issues/364).
