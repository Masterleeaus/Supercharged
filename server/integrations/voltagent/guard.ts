/**
 * VoltOps startup guard.
 *
 * VoltOps (VoltAgent's hosted console) must stay off. If either VoltOps key is
 * present in the environment, the server refuses to boot.
 */
const VOLTOPS_KEYS = ['VOLTAGENT_PUBLIC_KEY', 'VOLTAGENT_SECRET_KEY'] as const;

export function assertNoVoltOpsKeys(env: NodeJS.ProcessEnv = process.env): void {
  const set = VOLTOPS_KEYS.filter((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0;
  });
  if (set.length > 0) {
    throw new Error(
      `VoltOps is disabled for this deployment. Unset ${set.join(' and ')} before starting the server.`,
    );
  }
}
