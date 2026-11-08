# Workforce modules

Status: wiring and test coverage only. This table does not show that any module works in production.

## Scope

Every `.ts` file in these folders:

- `server/workforce/runtime/`
- `server/workforce/catalogue/` (including `roles/`)
- `server/workforce/tools/`
- `server/modules/approvals/`

Markdown files in those folders (`RUNTIME.md`, `SCHEMA.md`, `READ_TOOLS.md`, `PORT-NOTES.md`) are docs, not modules, and are not listed.

## Status key

- **wired**: imported at runtime, directly or through a chain of value imports, from `server/routes.ts`, `server/workforce/runtime/compose.ts` or `server/workforce/runtime/run.ts`.
- **built and tested in memory; NOT WIRED**: a test file exists, but nothing reaches the module from those three entry points.
- **NOT WIRED**: no test file, and nothing reaches the module from those entry points.

Notes on the key:

- Type-only imports are erased at runtime and do not count as wiring.
- Role files are not imported statically. `routes.ts` calls `loadCatalogueAtStartup()` (`startup.ts`), which calls `loader.ts`, which imports every `.ts` file in `roles/` whose name does not start with `_`. So the roles count as wired.
- `_example.ts` starts with `_`, so the loader skips it. It is marked NOT WIRED.
- Where a module has no test that imports it directly, the test column says so. Indirect coverage through a barrel file is named as indirect.

## Summary

- 167 rows: 41 non-role modules and 126 role files.
- Wired: 146. NOT WIRED: 21.
- The Postgres store and budget files (`pg-store.ts`, `pg-budgets.ts`) and the drizzle schema (`approvals/schema.ts`) are not applied to any database according to their own headers. This table does not change that.

## Modules

### Runtime (`server/workforce/runtime/`)

| File | Purpose | Test file | Status |
|---|---|---|---|
| `server/workforce/runtime/agent-view.ts` | Owner-facing view of one agent: role, autonomy tier, state, work, errors | `tests/workforce/agent-view.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/budgets.ts` | In-memory budget ledger (tool calls, tokens, spend, daily counters) and retry backoff | `tests/workforce/budgets.test.mjs` | wired |
| `server/workforce/runtime/citations.ts` | Checks that consequential recommendations cite verified business records | `tests/workforce/citations.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/compose.ts` | Composition root: builds the tool registry, run engine and approval gate, failing closed | `tests/workforce/compose.test.mjs`, `tests/workforce/compose-wiring.test.mjs` | wired |
| `server/workforce/runtime/controls.ts` | Pause, resume, disable, retire agents and stop runs, copy-on-write | `tests/workforce/controls.test.mjs` | wired |
| `server/workforce/runtime/freshness.ts` | Refuses actions that rely on stale, undated or future-dated context | `tests/workforce/freshness.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/health.ts` | Health handler for the workforce runtime; reports the model as never ready in this build | none direct | wired |
| `server/workforce/runtime/idempotency.ts` | Idempotency keys and a claim/complete store so retried tool calls do not repeat effects | `tests/workforce/idempotency.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/index.ts` | Barrel re-exporting runtime modules (imported by tests only) | `tests/workforce/runtime.test.mjs` (indirect) | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/pg-budgets.ts` | Postgres-backed budget ledger through an injected SQL executor | `tests/workforce/pg-budgets.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/pg-store.ts` | Postgres RunStore for run and audit tables through an injected SQL executor | `tests/workforce/pg-store.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/redact.ts` | Redacts secrets and personal contact details from logs, prompts and audit views | `tests/workforce/redact.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/review-inbox.ts` | Human review inbox for uncertain results, policy conflicts and failed actions | `tests/workforce/review-inbox.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/run-status-view.ts` | Maps internal run status to seven plain-English labels | `tests/workforce/run-status-view.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/run.ts` | Run lifecycle: status machine, budgets, retries, handoffs, delegation, audit trail | `tests/workforce/run-integration.test.mjs`, `tests/workforce/runtime.test.mjs` | wired |
| `server/workforce/runtime/scheduler.ts` | In-memory queue for once and recurring work, with retry backoff | `tests/workforce/scheduler.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/store.ts` | Run and audit persistence keyed by company; memory store and an unavailable production placeholder | `tests/workforce/runtime.test.mjs` (indirect, via `index.ts`) | NOT WIRED |
| `server/workforce/runtime/task-view.ts` | Owner-facing view of one run: plan, evidence, tool calls, approvals, outcome | `tests/workforce/task-view.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/runtime/team.ts` | Teams, handoffs and delegation with hard limits (pure functions) | `tests/workforce/run-integration.test.mjs`, `tests/workforce/handoff-enforcement.test.mjs`, `tests/workforce/handoff-depth-limit.test.mjs` | wired |
| `server/workforce/runtime/tool-registry.ts` | Single tool registry; checks each call in order (company, actor, schema, risk tier, policy, approval) | `tests/workforce/tool-registry-policy.test.mjs`, `tests/workforce/revoked-approval.test.mjs` | wired |
| `server/workforce/runtime/workforce-metrics.ts` | Pure metric counters and alert threshold rules | `tests/workforce/workforce-metrics.test.mjs` | built and tested in memory; NOT WIRED |

### Catalogue (`server/workforce/catalogue/`)

| File | Purpose | Test file | Status |
|---|---|---|---|
| `server/workforce/catalogue/index.ts` | Barrel re-exporting schema, validation and loader (imported by tests only) | `tests/workforce/catalogue.test.mjs` (indirect) | built and tested in memory; NOT WIRED |
| `server/workforce/catalogue/loader.ts` | Loads and validates every role file in `roles/`; returns a read-only registry; fails closed | `tests/workforce/catalogue-loader.test.mjs` | wired |
| `server/workforce/catalogue/prompt-version.ts` | Stable hash version for each role and for the whole catalogue | `tests/workforce/prompt-version.test.mjs` | built and tested in memory; NOT WIRED |
| `server/workforce/catalogue/role.schema.ts` | Zod schema every role definition must follow | `tests/workforce/catalogue.test.mjs` (indirect) | wired |
| `server/workforce/catalogue/startup.ts` | Loads the catalogue once at server startup; logs problems and never throws | `tests/workforce/catalogue-startup.test.mjs` | wired |
| `server/workforce/catalogue/validate.ts` | Validates a role set, including handoff target resolution | `tests/workforce/catalogue.test.mjs` (indirect) | wired |

### Tools (`server/workforce/tools/`)

| File | Purpose | Test file | Status |
|---|---|---|---|
| `server/workforce/tools/read-handlers.ts` | Typed, company-scoped read handlers for tools that roles declare | `tests/workforce/tools-read.test.mjs` | wired |
| `server/workforce/tools/simulator.ts` | Dry-run checker for tool calls; never calls a handler or writes | `tests/workforce/tool-simulator.test.mjs` | built and tested in memory; NOT WIRED |

### Approvals (`server/modules/approvals/`)

| File | Purpose | Test file | Status |
|---|---|---|---|
| `server/modules/approvals/approval-gate-adapter.ts` | Binds the runtime ApprovalGate to ApprovalService | `tests/modules/approval-gate-adapter.test.mjs` | wired |
| `server/modules/approvals/approval-routes.ts` | Express routes for the approval queue and rules | `tests/modules/approvals-revoke.test.mjs` | wired |
| `server/modules/approvals/approval-service.ts` | Approval state machine (pending, approved, rejected, expired), company-scoped queries | `tests/modules/approvals-revoke.test.mjs`, `tests/modules/approvals-resubmit-guard.test.mjs` | wired |
| `server/modules/approvals/approval-signing.ts` | HMAC-SHA256 signing of an approval decision, bound to the hash of the exact action | `tests/modules/approvals-revoke.test.mjs` | wired |
| `server/modules/approvals/approval-view.ts` | Builds the fields an approver must see; missing fields read as unknown | `tests/modules/approval-view.test.mjs` | built and tested in memory; NOT WIRED |
| `server/modules/approvals/authority-ladder.ts` | Table-driven decision: run, wait for owner approval, or refuse (assist, suggest, auto, predictive) | `tests/modules/authority-ladder.test.mjs` | wired |
| `server/modules/approvals/company-policy.ts` | Company rules that can only tighten the owner floor (money, customer send, delete) | `tests/modules/company-policy.test.mjs` | built and tested in memory; NOT WIRED |
| `server/modules/approvals/index.ts` | Registers the approvals module on the Express app at `/api/approvals` | none direct | wired |
| `server/modules/approvals/policy-engine.ts` | Rule-based policy engine, ported from agentgate-core (MIT) | `tests/modules/approvals-policy.test.mjs` | wired |
| `server/modules/approvals/policy-evaluator.ts` | One decision combining the authority ladder, company policy, permissions, approval state and money limits | `tests/modules/policy-evaluator.test.mjs`, `tests/modules/predictive-tier.test.mjs` | wired |
| `server/modules/approvals/schema.ts` | Drizzle table definitions for approvals (DRAFT, not applied to any database) | none direct | wired |
| `server/modules/approvals/types.ts` | Shared policy types, ported from agentgate-core; imported as types only | none direct | NOT WIRED (type-only; no runtime import) |

### Roles (`server/workforce/catalogue/roles/`)

The loader imports each file below at startup, so each is wired. Purposes are condensed from each role's `description`. Test files are the role suite that checks it.

| File | Purpose | Test file | Status |
|---|---|---|---|
| `server/workforce/catalogue/roles/_example.ts` | Template for new roles; skipped by the loader because its name starts with `_` | none | NOT WIRED |
| `server/workforce/catalogue/roles/appointment-reminder.ts` | Reminds customers about confirmed visits, with a person approving template and timing | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/carpet-upholstery-aftercare-follow-up.ts` | Checks in after carpet and upholstery visits and logs concerns for review | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/carpet-upholstery-job-scheduler.ts` | Schedules carpet and upholstery visits and sends changes for approval | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/carpet-upholstery-quote-intake.ts` | Qualifies carpet, rug and upholstery requests and flags delicate items | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/cleaning-booking-coordinator.ts` | Turns cleaning requests into booking requests and sends changes for approval | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/cleaning-crew-roster-coordinator.ts` | Proposes daily crew rosters for a person to approve before publishing | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/cleaning-customer-care.ts` | Logs cleaning complaints with the facts and hands refunds and claims to a person | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/cleaning-enquiry-reception.ts` | Answers first contact and routes requests to quoting or booking | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/cleaning-feedback-survey.ts` | Sends post-visit feedback requests and routes low scores to customer care | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/cleaning-invoice-query-desk.ts` | Explains cleaning invoices and logs disputes; money decisions stay with a person | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/cleaning-post-visit-quality-check.ts` | Reviews checklists and photos from finished visits and lists gaps | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/cleaning-quote-intake.ts` | Qualifies cleaning quote requests and passes reviewable briefs to the team | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/collections-follow-up.ts` | Later-stage contact on overdue accounts; proposes payment options for approval | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/commercial-cleaning-outbound-prospecting.ts` | Starts conversations with commercial prospects and hands interested ones to quoting | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/commercial-cleaning-site-visit-scheduler.ts` | Books site walkthroughs after confirming access and an on-site contact | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/complaint-triage.ts` | Records customer complaints, rates urgency and routes each to the right person | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/compliance-expiry-tracker.ts` | Tracks expiry dates of staff and company documents and flags items due soon (recommend only) | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/customer-data-hygiene.ts` | Finds duplicate and incomplete customer records and suggests fixes (recommendations only) | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/dispute-intake.ts` | Records payment disputes, places a contact hold and passes the case to a person | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/end-of-lease-clean-coordinator.ts` | Captures end-of-lease details and books the clean for approval | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-customer-care-recovery.ts` | Logs field-work complaints, drafts a calm reply and passes rework to intake | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-customer-status-update.ts` | Sends job status updates at each stage, using only what the job record shows | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-daily-schedule-brief.ts` | Writes a read-only morning brief of the day's visits, staffing and gaps | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-eta-delay-notice.ts` | Warns customers when a technician is running late, without promising an exact time | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-job-intake.ts` | Captures new field job requests, checks for an existing customer and routes them | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-job-photo-request.ts` | Asks technicians for before, during and after photos and holds the set for sign-off | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-materials-parts-reminder.ts` | Reminds technicians or stock owners of materials needed before upcoming visits | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-no-show-follow-up.ts` | Follows up missed field visits, offers rebooking and records the outcome | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-quote-follow-up.ts` | Follows up open field quotes and moves accepted ones to visit planning | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-rebooking-reminder.ts` | Reminds past customers when recurring work is due; records a rebooking only if they agree | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-review-request.ts` | Asks customers for a review after sign-off and routes unhappy replies to customer care | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-schedule-change.ts` | Handles requests to move an on-site visit and records the change once approved | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-signoff-request.ts` | Asks customers to sign off finished work and records only a sign-off they gave | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-technician-checkin.ts` | Prompts technicians to check in on arrival and starts the visit record | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-technician-checkout.ts` | Prompts technicians to check out, records work and materials, and sends the job to sign-off | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/field-visit-confirmation.ts` | Confirms booked visits with customers, including access details | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-after-hours-emergency-triage.ts` | Triages urgent garden and tree calls outside hours and passes emergencies to a person | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-booking-change-handler.ts` | Handles garden reschedules and cancellations; a person approves each change | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-crew-route-planner.ts` | Suggests daily crew routes for a supervisor to review (read-only) | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-customer-feedback-survey.ts` | Runs post-visit feedback for garden customers and records answers for review | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-irrigation-fault-triage.ts` | Sorts irrigation fault reports by urgency and water-damage risk | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-irrigation-repair-scheduler.ts` | Books irrigation repair visits with a fault record and an access window | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-job-completion-follow-up.ts` | Handles questions after a garden job is complete and routes complaints to a person | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-job-dispatch-coordinator.ts` | Prepares crew assignments for a supervisor to approve before saving | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-landscape-design-quote-intake.ts` | Captures a complete landscape design brief so a designer can quote | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-lawn-mowing-scheduler.ts` | Books one-off and recurring mowing visits for a person to confirm | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-maintenance-plan-enrolment.ts` | Explains maintenance plans and records interest for a person to approve | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-mulch-seasonal-campaign.ts` | Drafts seasonal mulch offers for review before anything is sent | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-quote-chaser.ts` | Follows up open garden quotes and records each reply against the quote | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-seasonal-reminder.ts` | Prepares seasonal garden reminders for approval before sending | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-service-history-reviewer.ts` | Reports repeat problems and gaps in garden history for a manager (read-only) | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-tree-lopping-quote-intake.ts` | Captures tree lopping enquiries and flags power-line or building risk | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/garden-weed-control-seasonal-campaign.ts` | Drafts seasonal weed control offers for review before sending | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/handyman-job-scoping.ts` | Qualifies handyman requests with scope questions, photos and an urgency tag | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/handyman-warranty-callback.ts` | Logs handyman warranty callbacks against the original job and passes them to customer care | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/home-cleaning-recurring-scheduler.ts` | Plans recurring home cleaning visits and proposes changes for approval | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/invoice-reminder.ts` | Sends courteous invoice reminders, with a person approving each message | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/lapsed-customer-reactivation.ts` | Drafts invitations to lapsed customers for a person to approve | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/locksmith-arrival-check.ts` | Guides identity and ownership checks on arrival; stops work until a person approves | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/locksmith-escalation-brief.ts` | Prepares a case brief when a locksmith request is escalated | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/locksmith-identity-verification.ts` | Runs identity and ownership checks before any locksmith visit or quote; escalates each case | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/locksmith-lockout-intake.ts` | Records lockout and rekey requests without confirming access | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/locksmith-rekey-quote.ts` | Prepares rekey quotes only after identity and ownership are verified | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/membership-renewal.ts` | Prepares renewal notices for membership and service agreements | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/new-customer-onboarding.ts` | Welcomes new customers, checks for an existing record and passes the account on | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/no-show-follow-up.ts` | Follows up missed bookings and offers a new time for a person to approve | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/painting-quote-follow-up.ts` | Reminds customers of agreed surfaces and prep notes before they decide on a painting quote | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/painting-site-prep-checklist.ts` | Prepares prep checklists and materials summaries for the office to review | `tests/workforce/roles-general-field.test.mjs` | wired |
| `server/workforce/catalogue/roles/payment-reconciliation-check.ts` | Compares payments with the invoices they should match and lists differences (recommendations only) | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/payment-reminder.ts` | Sends gentle past-due payment reminders, with a person approving each step | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/pest-inspection-booking.ts` | Books pest inspections with the concern, property type and an access window | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/pest-post-treatment-feedback.ts` | Collects feedback after each pest treatment and records it against the visit | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/pest-quote-follow-up.ts` | Follows up open pest quotes and records each reply against the quote | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/pest-reinspection-scheduler.ts` | Schedules re-inspections linked to the original visit | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/pest-seasonal-reminder.ts` | Prepares seasonal inspection reminders for approval before sending | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/pest-service-record-checker.ts` | Lists missing fields and overdue follow-ups in pest service records (read-only) | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/pest-treatment-follow-up.ts` | Checks in after a pest treatment and routes concerns to a licensed technician | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/pest-wildlife-callout-intake.ts` | Takes wildlife callouts, captures location and risk, and passes bite reports to a person | `tests/workforce/roles-garden-pest.test.mjs` | wired |
| `server/workforce/catalogue/roles/pool-booking-coordinator.ts` | Books pool service and water test visits; changes go to a person for approval | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/pool-customer-care.ts` | Logs pool service concerns and routes water or equipment dangers to escalation | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/pool-enquiry-reception.ts` | Answers pool enquiries and routes water-quality or equipment issues | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/pool-equipment-fault-intake.ts` | Logs pump, filter, heater and controller faults and escalates electrical or dangerous ones | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/pool-equipment-parts-quote-prep.ts` | Prepares parts and labour quote requests from logged faults, for a person to price | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/pool-service-scheduler.ts` | Plans recurring pool rounds grouped by area; changes go for approval | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/pool-water-quality-escalation.ts` | Logs water-quality and safety complaints and escalates every case without diagnosing | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/pool-water-testing-scheduler.ts` | Schedules water tests and routes flagged results to a person | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/post-job-check-in.ts` | Checks in after completed jobs and passes problems to complaint triage | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/quote-follow-up.ts` | Drafts courteous quote reminders for a person to approve before sending | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/referral-request.ts` | Asks satisfied customers for referrals, with a person approving each message | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/refund-triage.ts` | Prepares refund requests for a person to decide; never issues or promises a refund | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/review-monitor.ts` | Watches connected public reviews, flags new ones and suggests who should respond | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/service-due-reminder.ts` | Reminds customers when a recurring service is due; a person confirms any booking | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/staff-roster-suggestions.ts` | Suggests weekly rostering options (suggestions only) | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/stock-reorder-suggestions.ts` | Suggests stock reorders from stock levels; a person places every order | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/supplier-bill-check.ts` | Checks supplier bills against orders for duplicates and price differences | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/timesheet-check.ts` | Flags timesheet gaps, overlaps and unusual shift lengths for review | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-after-hours-handover-summary.ts` | Summarises overnight calls and requests for the first business-hours shift | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-after-hours-triage.ts` | Answers after-hours trade calls, captures urgent requests and pages the on-call person | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-backflow-test-reminder.ts` | Tracks due backflow tests and books them once the customer agrees | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-booking-confirmation.ts` | Confirms trade bookings with customers and handles simple changes | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-compliance-certificate-reminders.ts` | Reminds customers when a compliance certificate or safety check is due | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-electrical-test-certificate-tracker.ts` | Lists electrical test certificates due, overdue or missing, without judging the installation | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-gas-compliance-tracker.ts` | Lists gas compliance records due or missing for a person to review | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-gas-electrical-safety-escalation.ts` | Escalates gas and electrical safety reports to a person at once; never works a safety job alone | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-job-completion-follow-up.ts` | Confirms completed trade work with customers and checks for follow-up issues | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-job-completion-readiness.ts` | Checks finished jobs for missing paperwork, certificates, photos and sign-offs | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-job-notes-summariser.ts` | Summarises technician visit notes and flags follow-up or safety checks | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-job-scheduling-coordinator.ts` | Proposes visit slots from demand and crew availability; changes go for approval | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-parts-and-materials-check.ts` | Drafts a parts list from job scope and stock for the team to review | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-quote-drafting-assist.ts` | Prepares draft estimates from captured scope and rate data, for a person to approve | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-quote-follow-up.ts` | Follows up open trade quotes at agreed intervals and passes decisions back | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-quote-request-intake.ts` | Captures quote requests with site details, scope and photos, then routes them | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-reschedule-and-access-handler.ts` | Handles visit moves and no-access reports and proposes the next slot | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-review-request.ts` | Asks for reviews after satisfactory trade jobs and routes unhappy answers to customer care | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-seasonal-maintenance-reminder.ts` | Sends seasonal service reminders and offers a booking request when agreed | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-service-agreement-lapse-watch.ts` | Lists service agreements close to expiry or lapsed each week | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-service-agreement-renewal.ts` | Contacts agreement customers before renewal and drafts offers from approved terms | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-supplier-order-draft.ts` | Drafts supplier orders from approved parts lists for a buyer to submit | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-technician-dispatch-support.ts` | Suggests which technician should take each job, for the dispatcher to confirm | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-urgent-callout-triage.ts` | Sorts urgent callouts by urgency and safety risk and passes dangerous ones to a person at once | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/trades-warranty-callback-triage.ts` | Links repeat-fault and warranty callbacks to the original job | `tests/workforce/roles-trades.test.mjs` | wired |
| `server/workforce/catalogue/roles/warranty-callback-intake.ts` | Logs warranty requests against completed work and passes each to a person | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/weekly-business-report.ts` | Compiles a weekly summary of jobs, quotes, invoices and payments for managers | `tests/workforce/roles-back-office.test.mjs` | wired |
| `server/workforce/catalogue/roles/window-cleaning-quote-follow-up.ts` | Follows up window cleaning quotes without changing the quoted terms | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
| `server/workforce/catalogue/roles/window-cleaning-scheduler.ts` | Schedules window cleaning visits and routes height or weather-dependent work to a person | `tests/workforce/roles-cleaning-pool.test.mjs` | wired |
