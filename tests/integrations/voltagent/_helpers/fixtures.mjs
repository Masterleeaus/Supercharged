/**
 * Plain test data for workforce runtime tests: a company id, actors, roles, a team and a budget.
 * Returns plain objects only. Real createTeam() and createBudgetLedger() are called by the tests themselves,
 * so this file never needs to import the runtime.
 */

/** A default tenant. Valid as a string id (letters, digits, _ . -). */
export const DEFAULT_COMPANY_ID = 'co-test-1';

/** A second tenant, for cross-tenant checks. */
export const OTHER_COMPANY_ID = 'co-test-2';

/** Default run budget, the same shape the run engine takes. */
export function makeBudget(overrides = {}) {
  return { maxTokens: 50_000, maxToolCalls: 20, ...overrides };
}

/** Default retry policy, the same shape as RetryPolicy in run.ts. */
export function makeRetry(overrides = {}) {
  return { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, ...overrides };
}

/** Budget limits in the shape createBudgetLedger() takes. Every value is a positive integer. */
export function makeBudgetLimits(overrides = {}) {
  return {
    maxToolCallsPerRun: 20,
    maxTokensPerRun: 50_000,
    maxSpendCentsPerRun: 500,
    maxRunsPerCompanyPerDay: 100,
    maxSpendCentsPerCompanyPerDay: 5_000,
    ...overrides,
  };
}

/** An agent actor as the tool registry takes it. Autonomy defaults to 'auto'. */
export function makeAgentActor(roleId = 'writer', overrides = {}) {
  return { kind: 'agent', agentId: `${roleId}-1`, roleId, autonomy: 'auto', ...overrides };
}

/** A human actor as the tool registry takes it. */
export function makeHumanActor(userId = 'user-1') {
  return { kind: 'human', userId };
}

/** A role in the shape a RoleSource returns. Defaults: autonomy 'auto', no handoffs, no tool overrides. */
export function makeRole(id, overrides = {}) {
  return { id, handoffTo: [], autonomy: 'auto', ...overrides };
}

/**
 * A team input and a role source, ready for createTeam(input, roleSource).
 * The first member is the coordinator unless `coordinator` names another member.
 * Roles not given in `roles` are created with default settings, and a coordinator hands off to every other member.
 */
export function makeTeam({
  id = 'team-test-1',
  name = 'Test team',
  members = ['coordinator', 'writer', 'reviewer'],
  coordinator = members[0],
  roles = {},
} = {}) {
  const roleList = members.map((roleId) => {
    const given = roles[roleId] ?? {};
    const handoffTo = roleId === coordinator ? members.filter((m) => m !== coordinator) : [];
    return makeRole(roleId, { handoffTo, ...given });
  });
  const byId = new Map(roleList.map((r) => [r.id, r]));
  return {
    input: {
      id,
      name,
      members: members.map((roleId) => ({ roleId, coordinator: roleId === coordinator })),
    },
    roleSource: { getRole: (roleId) => byId.get(roleId) ?? null },
    roles: roleList,
  };
}
