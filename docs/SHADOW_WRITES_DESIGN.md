# Shadow writes: design (DECIDED, not yet built)

Status: decided by Jason on 2026-11-03. Build status is in /home/claude/supercharged-fixes-checklist.md.

## Decisions
1. Agent writes go to shadow copies in the SAME database, not a second database.
2. Only an approval copies a shadow change into the real desk tables.
3. Approval rules:
   - Category `money`, `customer_send`, `delete`: owner or manager only.
   - Category `other` (includes internal records, notes, drafts, updates to existing records): owner or manager, OR a second agent whose agentId and roleId differ from the requesting agent.
4. Tool access (`access: 'read' | 'write'`) decides whether a call is a write. Reads never create shadow changes.

## Shape
- New table `shadow_changes` (company_id NOT NULL, RLS like the other workforce tables):
  id, company_id, run_id, tool_id, category, target_table, target_id, operation (insert | update | delete), before_json, after_json, base_version, requested_by_agent_id, requested_by_role_id, policy_version, status (pending | approved | rejected | applied | conflict), approved_by_kind, approved_by_id, created_at, decided_at, applied_at.
- Apply runs in one transaction. It re-reads the target row and refuses with `conflict` if its version differs from base_version.
- A rejected or conflicted change is never applied and is kept for review.

## Not yet decided
- How reads show pending shadow changes (overlay or separate view). Default: reads show real data only; the UI lists pending changes.
- Retention of applied and rejected rows (see docs/RETENTION_PROPOSAL.md).

## Dependency
Most write tools have no handler yet (95 of 100 declared tools are unimplemented). The shadow layer is built now, and each write handler uses it when it is added.
