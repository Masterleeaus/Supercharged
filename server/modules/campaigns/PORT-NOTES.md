# Campaigns port notes

New module for Desk comms mode. Not mounted. No migration run. Nothing is sent by this module.

## Files

| File | What it is |
| --- | --- |
| `types.ts` | Campaign, audience (tag segment), step, send job, opt-in record, unsubscribe entry. Every entity has `companyId`. |
| `ports.ts` | `CampaignStore` (persistence, with compare-and-set `transitionJob`), `SendTransport`, `ApprovalPort`. |
| `campaign-service.ts` | Pure service: consent, audience resolution, approval-bound batch release, dispatch choke point. |
| `memory-adapter.ts` | `InMemoryCampaignStore`, `RecordingSendTransport` (records calls, never sends), `InMemoryApprovalPort`. |
| `drizzle-adapter.ts` | `createDrizzleCampaignStore()`. Throws until the DRAFT migration is promoted. |
| `index.ts` | Exports. Not mounted. |
| `../../../migrations/DRAFT_campaigns.sql` | Draft tables. Not run. |
| `../../../tests/modules/campaigns.test.mjs` | 30 `node:test` cases. |

## Reused

| Existing code | How it is used |
| --- | --- |
| `server/modules/approvals/approval-service.ts` | Same structural gate as inbox. Action `campaigns.send_step`. |
| `server/modules/chatbot/chatbot-scope.ts` `requireCompanyId` | Company-scope guard. |
| `server/modules/booking-agent/dispatcher.ts` | Flow pattern: nothing reaches the transport unless the gate result is approved. |
| `migrations/DRAFT_*.sql` | DRAFT conventions. |

## Not reused, and why

- `shared/schema.ts` `campaigns`, `contacts`, `campaignJobs`. These are voice-call campaigns keyed by `user_id`, with no company_id and no channel. Reusing them would mix two models. Left alone.
- `server/services/campaign-executor.ts`, `campaign-scheduler.ts`. Call-campaign executors. Not read for reuse.
- No opt-in or unsubscribe logic exists in Desk. `seed-email-templates.ts` has an `{{unsubscribeUrl}}` placeholder only. The consent model is new here.
- `server/services/email-service.ts` is not used. The transport is injected, and nothing here calls SMTP.

## Design

- One approval per campaign step, not per recipient. The approval is bound to `recipientsSha256` (sorted channel:address list), `recipientCount` and `bodySha256`.
- `inApprovedSet` is fixed at request time. An unsubscribe after approval changes that job's status but not the hash.
- Three consent checks: request (excluded jobs recorded as `skipped`), release (approved jobs are re-checked), dispatch (re-checked again). Unsubscribe always wins over opt-in.
- `dispatchJob` is the only path to `SendTransport`. It refuses unless the job is `queued` and its approval is `approved` for the same step.

## Decisions for review

1. A send to an audience with zero opt-in records is refused outright (`refused`, `optInCount === 0`). Members without an active opt-in are skipped one by one, not failed.
2. Humans and agents both go through the gate. No bypass.
3. Opt-ins are per address and per channel, not per contact id. Address is lowercased for email.
4. Steps can be added only to a draft or paused campaign. A step's content is locked by its hash once requested.
5. A new `requestSend` for a step that already has live jobs is refused. Retrying a failed step needs a new step (not built).
6. `markExecuted` is called once per release, after at least one job is queued. It does not mean delivered.
7. Campaigns run one step at a time. `delayHours` is stored but nothing schedules it yet.

## Known gaps before real use

- `transitionJob` must be a conditional UPDATE in Drizzle. The memory version is compare-and-set. Without that, two workers can both claim a job.
- A release that fails partway leaves some jobs queued and some awaiting. A retry sees the hash over `inApprovedSet` jobs, so it still works, but nothing reports the partial state.
- No scheduler, no retry policy, no bounce or complaint handling, and no provider adapter.
- Contacts are created in-process. There is no import path yet.
