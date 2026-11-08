# Auto Reconciliation Design (Desk)

Status: design only. Nothing here is built unless a file is named as the implementation. The owner's description is the source of truth. Anything the owner has not decided is marked OPEN QUESTION.

## 1. Purpose and scope

Desk's AI workforce runs its daily tasks on its own. Every intended and executed action goes to a journal. A reconciliation engine checks the journal against the databases, sends owner items, and marks the database reconciled when all is good.

In scope: the run path, approvals, the journal, reconciliation, and the four tiers. Out of scope: agent roles, UI, billing.

## 2. The two databases

The owner says the design uses "two databases and a journal." DECIDED by Jason, 2026-11-03: the two databases are live data and a check copy (the shadow store). See section 8, question 1, for the conflict to resolve.

Options considered:
- A. An intent store (what an agent planned) and an outcome store (what actually ran). Reconciliation compares them.
- B. Desk's own data and an external system of record, such as a payments provider. Reconciliation compares Desk with that system.
- C. Live data and a separate check copy (replica or shadow) that the engine reads.

Code check: no file uses the phrase "two databases." The nearest persisted state is the run store (`server/workforce/runtime/store.ts`, where the production store throws until a schema exists) and the approvals table (`server/modules/approvals/schema.ts`).

## 3. The journal

An append-only log. Each action writes an intent row before it runs and an outcome row after it. Rows are never updated or deleted.

Fields:
- journal_id, company_id, run_id, approval_id (where applicable)
- actor: verified human user id or verified agent id
- agent: agent id and role id
- tier: risk tier and autonomy level used for the decision
- action: tool id
- params_sha256: hash of the params. Raw params are never stored.
- timestamp
- outcome: intended, allowed, awaiting_approval, executed, failed, refused, duplicate, or unknown
- prev_hash and entry_hash, for a hash chain

Existing parts: `tool-registry.ts` writes decision and execution events with `paramsSha256` and no raw params. `store.ts` defines an `AuditEvent` shape. `audit-chain.mjs` computes and verifies a hash chain.

Gaps:
- `server/services/audit-log.ts` queues events in memory, flushes every 5 seconds, and drops events when a flush fails. Its flush writes no hash fields, so no caller writes the chain.
- There is no `unknown` or `duplicate` outcome.
- No code enforces append-only storage. I did not check `shared/schema.ts` for database rules.

## 4. The reconciliation engine

For each intent in the journal, the engine checks:
1. Does an outcome row exist?
2. Does the outcome's params hash match the intent's?
3. Does the database state match what the outcome says should be there? (Depends on section 8, question 1, decided 2026-11-03.)

When it runs: on a schedule (nightly is proposed), and on events (after a run completes, and after an owner decides an approval). Nothing schedules it today. `server/workforce/runtime/RUNTIME.md` lists the scheduler and background resume as not built.

On match: mark the intent reconciled and mark the database entry reconciled.

On mismatch: stop further actions of that class for that company and create an owner approval item with the evidence. Do not retry automatically.

On unknown outcome (for example a timeout, where the provider may or may not have acted): mark the intent `unknown`, do not retry any side-effecting action, and create an owner item. If the provider offers a read-back query, run it first.

Owner items reuse the approval queue. `ApprovalService.gateAction` (`approval-service.ts`) already queues a request for a human when no policy decides.

## 5. The four tiers

Naming: the code's "risk tiers" (low, medium, high, critical, in `server/modules/approvals/authority-ladder.ts`) are a different thing from the owner's four tiers. This document uses the owner's names.

- Auto. The agent runs daily tasks without approval. The closest code is `delegated_autonomous`, which still needs approval for high-tier actions and denies critical ones (question 2). Auto actions still write journal rows.
- Always owner approval. Money movement, customer messages, and deletes, routed to the owner whatever a policy decides (section 6).
- Predictive. Proposed: prepares for tomorrow, next week and later. Produces forecasts and drafts only; any resulting action goes through Auto or always-approval. No code found.
- Suggest. Proposed: watches set sources, such as an inbox, and notifies the owner. It does not act. No code found.

## 6. The always-owner-approval list

The list: payments and refunds, outbound messages to customers, and deletion of records.

Proposed enforcement:
1. Each tool on the list carries an action class, kept in one place that the engine reads before the authority ladder.
2. A call in that class needs an approval decided by a `dashboard:` user. A `policy:` decision is not enough.
3. Without that human approval, the call is refused, whatever tier or autonomy level applies.

Today: `tool-registry.ts` refuses approvals that are not human decisions (`approval_not_human`), so a policy auto-approval cannot run a gated tool. There is no action-class list, though. Enforcement depends on the caller's tier and the role's autonomy. `painting-quote-follow-up.ts` tags `messages.send_customer` as `medium`, and `collections-follow-up.ts` tags `customer_messages.send` as `medium`. Both roles use `approval_required`, so they wait today. Under `delegated_autonomous`, `authority-ladder.ts` would allow those medium-tier sends without approval.

## 7. Failure modes

Crash mid-action:
- Crash after "allowed" is written, before the claim: nothing ran and the approval is unused. Recovery: reconciliation re-reads state and re-runs only an idempotent action. Otherwise it creates an owner item.
- Crash after the claim, before the handler: `markExecuted` has set `executedAt`, but nothing ran. Recovery: the owner must approve again, since a re-run is refused as `approval_consumed`.
- Crash after the handler, before the outcome row: `finish()` in `tool-registry.ts` swallows audit write errors. Recovery: mark `unknown`, read back, and create an owner item.

Duplicate runs:
- `createRun` in `server/workforce/runtime/run.ts` takes no idempotency key, so starting the same job twice creates two runs.
- A timed-out tool is retried when there is no approval. `tool-registry.ts` marks timeouts as transient, and `run.ts` retries transient failures when `approvalId === null`. `RUNTIME.md` says the handler keeps running after a timeout. A side-effecting Auto tool can therefore run twice.
- Proposed: each intent carries a key from run id, action and params hash. A repeat key is refused and logged as `duplicate`. The external port sends an `idempotency_key`, but `WORKFORCE_RUNTIME.md` marks the endpoint that honours it as ASSUMED.

Provider timeouts:
- A timeout is not a failure. The HTTP client defaults to 5 s (`WORKFORCE_RUNTIME.md`). Proposed: record `unknown`, do not retry side effects automatically, run a read-back query if one exists, and create an owner item.

## 8. Open questions

1. What the two databases are. Options: A intent and outcome stores; B Desk and an external system of record; C live data and a check copy.
   DECIDED by Jason, 2026-11-03: C. Live data, and a check copy (the shadow store) that the engine reads.
   CONFLICT TO RESOLVE: `docs/SHADOW_WRITES_DESIGN.md` (also dated 2026-11-03) puts shadow copies in the same database, in a `shadow_changes` table, not in a second database. `/home/claude/supercharged-fixes-checklist.md` (line 22, 2026-11-03) describes the second database as an append-only action ledger, which is closer to the journal in section 3. Jason to confirm which he meant. Until then the form of the check copy is not settled.
2. Does Auto mean no approval at all, even for high-tier actions? Options: A add a new autonomy level above `delegated_autonomous` with no approval; B keep approval for high-tier actions, as the code does now; C no approval for low-tier actions only.
3. Where the always-approval list lives. Options: A an action-class list in code; B a flag on each tool definition; C policy rows in the database.
4. Where the journal is stored. Options: A the same database as the actions, written in one transaction; B a separate append-only store; C an external log service.
5. How provider calls avoid duplicates. Options: A provider idempotency keys; B Desk-side dedupe on the intent key; C both.
6. How `unknown` outcomes are resolved. Options: A the owner decides each time; B read-back first, then the owner if still unclear; C block the action class until a reconciliation pass clears it.
   DECIDED by Jason, 2026-11-03: B. Read back first, then the owner if still unclear.
7. When reconciliation runs. Options: A nightly only; B nightly plus after each run; C nightly plus after each owner decision.
   DECIDED by Jason, 2026-11-03: B. Nightly plus after each run.
8. What predictive work may write. Options: A read-only forecasts; B drafts; C staged actions that still need Auto or approval.
9. What the suggest tier watches and how it notifies. Options: A inbox only; B inbox plus a configured channel; C in-app only.
10. Whether the workforce HTTP runtime executes actions or only tasks. Options: A it executes; B only the in-process registry executes; C both, split by workflow.
   DECIDED by Jason, 2026-11-03: B. Only the in-process registry executes actions; the HTTP runtime handles tasks only.
11. Whether timed-out side-effecting Auto tools may be retried. Options: A never; B retry with the same idempotency key; C retry read-only tools only.
   DECIDED by Jason, 2026-11-03: B. Retry a timed-out side-effecting Auto tool with the same idempotency key. Conflicts with the current code, which never retries a timed-out write; not yet reconciled.

## 9. Mapping to existing code

| Part | File | Status | Missing |
|---|---|---|---|
| Action gate | `server/workforce/runtime/tool-registry.ts` | Exists. Writes allowed and execution events. | Journal wiring, `unknown`/`duplicate`, action-class list |
| Run lifecycle | `server/workforce/runtime/run.ts` | Exists. State machine, budgets, retry. | Scheduler, resume, idempotency key |
| Run store | `server/workforce/runtime/store.ts` | In-memory store only. Production throws. | Database schema |
| Approvals | `server/modules/approvals/approval-service.ts`, `schema.ts`, `approval-routes.ts` | Exists. Pending, decided, executed. | Action-class check. `POST /:id/executed` also sets `executed`. |
| Authority ladder | `server/modules/approvals/authority-ladder.ts` | Exists. Six autonomy levels, four risk tiers. | An Auto level (question 2) |
| Policy decisions | `server/modules/approvals/policy-engine.ts` | Exists. | Block auto-approval for the always-approval list |
| Audit log | `server/services/audit-log.ts` | In-memory queue, 5 s flush. | Durable, append-only journal |
| Hash chain | `server/services/audit-chain.mjs` | Helper only. | A writer that uses it |
| Workforce adapter | `server/integrations/workforce-runtime/` | Exists. Disabled. Endpoints ASSUMED. | Verification against `services/workforce` |
| Reconciliation, predictive, suggest | None | Not found in repo. | Sections 4 and 5 |
