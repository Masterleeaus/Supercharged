/**
 * Decides whether a plugin's register function actually registered anything.
 * Only an explicit { registered: true } counts. A void return, a skip result such as
 * { registered: false, reason }, or a non-boolean value does not.
 */
export function isRegistrationAccepted(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { registered?: unknown }).registered === true;
}

/** Short, bounded reason from a skip result for logs and the plugin error field. */
export function registrationReason(result: unknown): string {
  const reason = typeof result === 'object' && result !== null ? (result as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' ? reason.slice(0, 120) : 'none';
}
