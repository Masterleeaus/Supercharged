/*
 * Inbox module entry point. Not mounted: server/routes.ts and index.ts are untouched.
 * Build the service with createInboxService({ store, approvals }). Without a store,
 * use createDrizzleInboxStore(), which throws until the DRAFT migration is promoted.
 */
export { createInboxService, InboxError, sha256 } from './inbox-service.ts';
export type { InboxService, InboxServiceDeps, InboundInput, InboundResult, InboxErrorCode } from './inbox-service.ts';
export { InMemoryInboxStore, InMemoryApprovalPort } from './memory-adapter.ts';
export { createDrizzleInboxStore } from './drizzle-adapter.ts';
export type { InboxStore, ApprovalPort, ApprovalGateRequest, ApprovalGateResult, ApprovalRecord, ApprovalState, ThreadFilter } from './ports.ts';
export * from './types.ts';
export { createInboxRouter, type InboxRouterDeps } from './inbox-router.ts';
