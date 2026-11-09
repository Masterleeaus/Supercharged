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
export { createInboxRouterForProduction, type InboxProductionRouterDeps } from './production-router.ts';
// Production routers verify all required InboxService operations before accepting the dependency.

export { createSqlInboxStore } from './sql-store.ts';
export { runInboundLocked, lockedInboxClient } from './sql-lock.ts';

// Inbox PostgreSQL candidate RLS is verified in an isolated CI job; production remains disabled.

export {verifyInboxSchema,requireInboxSchema,INBOX_TABLES} from './schema-readiness.ts';
export type {InboxReadiness,InboxSchemaProbe} from './schema-readiness.ts';
export {createVerifiedInboxService} from './production-service.ts';
export type {VerifiedInboxDependencies} from './production-service.ts';

export {createInboxSqlTransactionRunner,inboxTransactionsFor} from './sql-transaction-runner.ts';

export {createInboxApprovalPort} from './approval-port.ts';
export type {CanonicalApprovalPortSource} from './approval-port.ts';
