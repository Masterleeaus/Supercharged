/**
 * Explicit, async production composition for comms Marketing.
 * No routes are mounted until the persisted store and restricted RLS policy
 * have passed the current database readiness check.
 */
import type { Express, RequestHandler } from 'express';
import { createVerifiedMarketingService } from '../../modules/marketing/production-service.ts';
import { chatbotReferences, unavailableCampaignReferences } from '../../modules/marketing/reference-adapters.ts';
import { createDrizzleChatbotStorage } from '../../modules/chatbot/chatbot-storage.ts';
import type { ChatbotStorage } from '../../modules/chatbot/chatbot-storage.ts';
import type { CampaignRefs } from '../../modules/marketing/ports.ts';
import type { TenantPool } from '../../infrastructure/database/tenant-context.ts';
import type { MarketingSchemaProbe } from '../../modules/marketing/schema-readiness.ts';
import { registerOptionalCommsRoutes } from './optional-comms-routes.ts';
import { createVerifiedInboxService } from '../../modules/inbox/production-service.ts';
import { createCanonicalInboxApprovalService } from '../../modules/inbox/canonical-production-approval.ts';
import type { CanonicalApprovalPortSource } from '../../modules/inbox/approval-port.ts';
export interface VerifiedCommsDependencies {
 authenticate:RequestHandler;
 requireCompanyScope:RequestHandler;
 requireRole:(...roles:string[])=>RequestHandler;
 pool:TenantPool;
 schemaProbe:MarketingSchemaProbe;
 chatbots?:Pick<ChatbotStorage,'findChatbot'>;
 campaigns?:CampaignRefs;
 approvalService?:CanonicalApprovalPortSource;
 env?:Record<string,string|undefined>;
}
export async function registerVerifiedCommsRoutes(app:Pick<Express,'use'>,deps:VerifiedCommsDependencies) {
 if(!deps)throw new Error('comms: verified dependencies required');
 const env=deps.env??process.env;
 const enabled=env.COMMS_MARKETING_ENABLED==='true';
 const inboxEnabled=env.COMMS_INBOX_ENABLED==='true';
 // Auth, company and role guard validation happens before any DB inspection.
 if(typeof deps.authenticate!=='function'||typeof deps.requireCompanyScope!=='function'||typeof deps.requireRole!=='function') {
  throw new Error('comms: authentication, company scope and role guards required');
 }
 const marketing=enabled ? await createVerifiedMarketingService({
  pool:deps.pool,
  schemaProbe:deps.schemaProbe,
  chatbots:chatbotReferences(deps.chatbots??createDrizzleChatbotStorage()),
  // Campaign storage is still an unpromoted draft; never use legacy voice campaigns.
  campaigns:deps.campaigns??unavailableCampaignReferences(),
 }) : undefined;
 // Both enabled backends verify before any route is mounted.
 const inbox=inboxEnabled?await createVerifiedInboxService({
  pool:deps.pool,schemaProbe:deps.schemaProbe,
  approvalService:deps.approvalService??await createCanonicalInboxApprovalService(deps.pool),
 }):undefined;
 return registerOptionalCommsRoutes(app,{
  authenticate:deps.authenticate, requireCompanyScope:deps.requireCompanyScope,
  requireRole:deps.requireRole,marketing,inbox,env,
 });
}
