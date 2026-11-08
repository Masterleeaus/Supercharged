# Workforce runtime

One tool registry for every agent, team handoffs and delegation with hard limits, and a run lifecycle with
budgets, retries and an audit trail. Nothing here touches the database, the network or the environment. The
composition root injects the approval gate, the redactor, the audit sink and the run store.

Tests: `cd /home/claude/work/merged4 && node --test tests/workforce/runtime.test.mjs`

## Register a tool

```ts
registry.register({
  id: 'publish_page',          // lowercase, starts with a letter, up to 128 chars
  risk: 'high',                // low | medium | high | critical
  schema: { slug: { type: 'string', required: true } },
  handler: async (params, { companyId, signal }) => {
    // honour `signal`: on timeout it is aborted, but the handler keeps running unless it checks it
    return { url: `/p/${params.slug}` };
  },
});
```

Throw `transientError('upstream 503')` for a failure that may succeed on retry. Any other throw is final.

Every call goes through one path: companyId, then actor, then tool id, then input (unknown fields and tenant
keys are refused), then the authority ladder, then the approval gate when needed, then the audit write, then
the handler. Output is redacted and capped at `maxOutputBytes` (default 16 KiB).

## Define a team

```ts
const team = createTeam(
  {
    id: 'content-team',
    name: 'Content',
    members: [
      { roleId: 'coordinator', coordinator: true },   // exactly one member must be the coordinator
      { roleId: 'writer' },
      { roleId: 'reviewer' },
    ],
  },
  roleSource, // { getRole(roleId) } backed by the catalogue
);
```

Each role supplies `handoffTo` (roles it may hand to or delegate to), `toolRisk` (per-tool tier, which can raise a
tool's tier but never lower it) and `autonomy` (one of the four tiers: `assist`, `suggest`, `auto`, `predictive`). The team copies these at creation.

## Start a run

```ts
const engine = createRunEngine({ registry, store, audit: sink });

const created = await engine.createRun({
  companyId: 'co-42',
  team,
  budget: { maxTokens: 50_000, maxToolCalls: 20 },
  retry: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 },
});
const runId = created.run.id;
await engine.startRun('co-42', runId);

// the agent calls a tool; the engine checks budget, role and approval
const actor = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' }; // autonomy comes from the team, not the caller
const result = await engine.callTool('co-42', runId, {
  toolId: 'publish_page',
  params: { slug: 'home' },
  actor,
});

if (result.tool?.outcome === 'awaiting_approval') {
  // a human approves in the dashboard, then the same actor resumes with the same params
  await engine.resumeAfterApproval('co-42', runId, { toolId: 'publish_page', params: { slug: 'home' }, actor });
}

await engine.handoff('co-42', runId, { actor, toRole: 'reviewer' });  // only the current owner may hand off
await engine.complete('co-42', runId, 'published');
```

## Worked example: a high-risk publish

1. `writer` (autonomy `auto`) calls `publish_page` (risk `high`). The ladder says
   `approval`, so the gate records a pending approval and the run moves to `awaiting_approval`.
2. A human approves with a `dashboard:` decision. `resumeAfterApproval` re-reads the approval and checks that
   the tool, the params hash and the actor match. The approval is claimed before the handler runs.
3. Calling again with the same approval is refused as `approval_consumed`.

## Adapter contract for the approval gate

The gate is an interface. It is not connected to a real service yet.

- `gateAction` maps to `ApprovalService.gateAction`.
- `readApproval(companyId, id)` maps to `ApprovalService.getApproval`, and must also return `paramsSha256`
  (from `context.paramsSha256` stored at request time) and `executed`.
- `claimApproval(companyId, id, actorId)` must be atomic: succeed only when the approval is approved and not yet
  executed. `markExecuted` alone is not enough unless its update is conditional.
- A `policy:` decision (auto-approval) is not a human decision and is refused.

## Ported from Clean-Hub (read only)

| Clean-Hub | Here |
| --- | --- |
| `AgentTeamManager::createTeam` | `createTeam` (team = named role set, with one coordinator) |
| `createHandoff` / `acceptHandoff` ownership check | `planHandoff`: the handoff path's last role must be the caller |
| `ToolRouter` tenant override and registered-tool-only checks | `tool-registry.ts`: `hasTenantOverride`, unknown tools fail closed |

Left out: `selectAgents` scoring and per-agent task queues (the run budget replaces them), `getWorkload`,
Laravel collections, `now()` and `Str::uuid()`, the ToolRouter capability and WorkCore action dispatch, and idempotency keys.

## Not built

- Real model calls and provider clients (token counts come from the caller through `recordTokens`).
- The database schema and the production run store (`createUnavailableRunStore` throws until it exists).
- The scheduler and any background resume. A waiting run is resumed by a call from the composition root.
- The catalogue role loader. `RoleSpec` is the brief's field list, not a verified SCHEMA.md.
