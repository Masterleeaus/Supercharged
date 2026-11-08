# Approvals hook (written, not wired)

This describes the call the approvals service should make to use the decision engine. Nothing in `server/modules/approvals/` calls it yet.

## What approvals does today

`ApprovalService.gateAction(input)` in `server/modules/approvals/approval-service.ts` takes a `GateActionInput` (`companyId`, `requestedBy`, `agentId`, `action`, `params`, `context`, `urgency`, `ttlMs`). It loads the company's enabled rules, runs `evaluatePolicy`, and returns `approved`, `rejected`, or `pending`. It persists a redacted copy of the params. No caller of `gateAction` exists elsewhere in `server/` or `shared/`.

## The call to make

The approvals service should call the step 27 handoff through the engine's namespace export, after the step 26 workflow has produced the eligible recommendation.

```ts
import { ActionHandoff } from "../../engines/decision/index.js";

const now = new Date();
const handoff = ActionHandoff.prepareDecisionActionHandoff(
  {
    company_id: input.companyId,            // verified tenant from GateActionInput; never the request body
    decision_subject_id: run.decisionSubjectId,
    decision_id: run.decisionId,
    as_of: now.toISOString(),
    constraint_gate: {
      state: "ready",                        // from the step 26 constraints stage
      company_id: input.companyId,
      eligible_option_ids: gate.eligible_option_ids,
    },
    recommendation: {
      company_id: input.companyId,
      decision_subject_id: run.decisionSubjectId,
      decision_id: run.decisionId,
      status: "recommend",
      recommended_option_id: optionId,
      authority_effect: "none",
    },
    binding: {
      action_id: input.action,
      option_id: optionId,
      capability_id: capabilityId,
      capability_version: capabilityVersion,
      target_ref: null,
      parameters: input.params,              // must be plain JSON; see mismatch 4
      evidence_refs: [],
    },
    capability_assessment: {                 // host-produced, fresh, from the host's own check
      company_id: input.companyId,
      capability_id: capabilityId,
      actor_id: input.agentId ?? input.requestedBy,
      availability: "available",
      authorization: "allowed",              // or "approval_required" / "denied" / "unknown"
      policy_version: policyVersion,
      assessed_at: assessedAt,
      expires_at: assessmentExpiresAt,
    },
  },
  { clock: () => now.toISOString(), max_assessment_age_seconds: 300, max_request_age_seconds: 300 },
);
```

The engine returns `{ status, reason_codes, prepared_request? }` with `authority_effect: "none"`. `prepared_request.dispatch_state` is always `"not_dispatched"`.

## Proposed handling of each handoff status (decisions for review)

| Handoff status | Proposed approvals behaviour |
| --- | --- |
| `prepared` (authorization `allowed`) | Still run `evaluatePolicy`. `auto_approve` may approve; anything else creates a `pending` row. |
| `approval_required` | Always create a `pending` row routed to a human. Policy must not auto-approve. |
| `blocked`, `abstained`, `review_required` | Create no request. Record a `rejected` row with the `reason_codes` as the decision reason, or return the reason to the caller. |

Dispatch is a separate step. Desk's `DeskDispatch.dispatch(prepared_request)` runs only after the approval is `approved`, and the approvals service owns that call.

## Mismatches in shape

1. **Status vocabulary.** Approvals uses `pending | approved | rejected | expired` and policy decisions `auto_approve | auto_deny | route_to_human | route_to_agent`. The handoff uses `prepared | approval_required | abstained | blocked | review_required`. No one-to-one mapping exists.
2. **Casing and fields.** `companyId`, `requestedBy`, `ttlMs` become `company_id`, `capability_assessment.actor_id`, and `expires_at` plus `max_request_age_seconds`. The handoff also needs a recommendation and a constraint gate, which `GateActionInput` does not carry.
3. **Upstream dependency.** The handoff needs the step 26 workflow output (gate, recommendation). Approvals has no such input today.
4. **Parameters.** `binding.parameters` must be a plain JSON object. Dates, class instances, and other non-JSON values are rejected. The approvals service redacts params only before persisting; `prepared_request.parameters` is unredacted and must go through the same redactor before storage.
5. **Idempotency.** The handoff returns `request_id` and `idempotency_key`. The `approvals` table has no idempotency-key column, so replays cannot be detected without a schema change (not made here).
6. **Policy context.** Approvals scopes policies by `agentId` and `tool` (set to the action name). The handoff separates `action_id` from `capability_id`. Choose which one feeds the `tool` scope.
7. **Expiry.** Approvals uses `ttlMs` for `expiresAt`. The handoff expires at the earlier of the host assessment expiry and `max_request_age_seconds` (default 300). The two must be aligned.
8. **Identity.** Approvals takes `agentId` and `requestedBy` from verified callers. The handoff takes one `actor_id`. Decide which verified id is the actor.
