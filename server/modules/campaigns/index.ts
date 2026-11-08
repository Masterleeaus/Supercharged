/*
 * Campaigns module entry point. The comms router is mounted at /api/comms in server/routes.ts
 * (about line 2723), fail closed: the store, approvals and transport all throw until the
 * DRAFT_campaigns migration is promoted and real ports are wired.
 * Build with createCampaignService({ store, approvals, transport }). Without a store,
 * use createDrizzleCampaignStore(), which throws until the DRAFT migration is promoted.
 */
export { createCampaignService, CampaignError, normaliseAddress, recipientsHash, contentHash, sha256 } from './campaign-service.ts';
export type { CampaignService, CampaignServiceDeps, ConsentChecker, AudienceResolution, ReleaseState, SendRequestResult, CampaignErrorCode } from './campaign-service.ts';
export { InMemoryCampaignStore, RecordingSendTransport, InMemoryApprovalPort } from './memory-adapter.ts';
export { createDrizzleCampaignStore } from './drizzle-adapter.ts';
export { createSendQueue, InMemorySendQueueStore, idempotencyKey } from './send-queue.ts';
export type { CampaignStore, SendTransport, ApprovalPort, ApprovalGateRequest, ApprovalGateResult, ApprovalRecord, ApprovalState } from './ports.ts';
export * from './types.ts';
export {
  createCampaignsRouter,
  createCampaignRouterForProduction,
  createCampaignServiceForProduction,
  type CampaignServiceProductionDeps,
  scopeFromLocals,
  type CampaignsRouterDeps,
  type CampaignRouterProductionDeps,
  type ProductionRequest,
} from './campaigns-router.ts';
