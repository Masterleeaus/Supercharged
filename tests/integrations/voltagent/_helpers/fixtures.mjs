/**
 * Shared fixtures for VoltAgent tests. Two tenants are defined so isolation tests can use both.
 */
export const TENANT_A = Object.freeze({ companyId: '11111111-1111-4111-8111-111111111111', name: 'Tenant A' });
export const TENANT_B = Object.freeze({ companyId: '22222222-2222-4222-8222-222222222222', name: 'Tenant B' });

export function agentRunFixture(overrides = {}) {
  return {
    companyId: TENANT_A.companyId,
    agentName: 'booking-agent',
    sessionId: 'session-1',
    response: { result: 'Booked', tool_calls: [] },
    latencyMs: 100,
    ...overrides,
  };
}
