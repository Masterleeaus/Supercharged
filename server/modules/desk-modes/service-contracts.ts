/**
 * Validates the runtime operations required by communications routers.
 * Do not use an object merely being truthy as evidence of a wired service.
 * This detects missing bindings at startup; it does not prove persistence.
 */
export const INBOX_OPERATIONS = [
  'listThreads', 'getThread', 'listMessages', 'assignThread', 'setThreadStatus',
  'createDraft', 'sendAsStaff', 'requestSend',
] as const;
export const MARKETING_OPERATIONS = [
  'listPages', 'getPage', 'createPage', 'updatePage', 'publishPage', 'archivePage',
  'listContent', 'getContent', 'createContent', 'updateContent', 'approveContent', 'publishContent',
] as const;
export type ServiceContractName = 'inbox' | 'marketing';
export function assertServiceContract(
  name: ServiceContractName,
  service: unknown,
): asserts service is Record<string, (...args: unknown[]) => unknown> {
  if (!service || (typeof service !== 'object' && typeof service !== 'function')) {
    throw new Error(`${name}: a service with callable operations is required`);
  }
  const operations = name === 'inbox' ? INBOX_OPERATIONS : MARKETING_OPERATIONS;
  const missing = operations.filter(key => typeof (service as Record<string, unknown>)[key] !== 'function');
  if (missing.length) {
    throw new Error(`${name}: service missing operations: ${missing.join(', ')}`);
  }
}
