/**
 * No implicit in-memory adapters. The production service requires a PostgreSQL pool,
 * real campaign/chatbot reference adapters, and verified database RLS readiness.
 */
import { createMarketingService, type MarketingService } from './marketing-service.ts';
import { createSqlMarketingStore } from './sql-store.ts';
import { requireMarketingSchema, type MarketingSchemaProbe } from './schema-readiness.ts';
import type { CampaignRefs, ChatbotRefs } from './ports.ts';
import type { TenantPool } from '../../infrastructure/database/tenant-context.ts';
export interface MarketingProductionServiceDeps {
  pool: TenantPool;
  schemaProbe: MarketingSchemaProbe;
  campaigns: CampaignRefs;
  chatbots: ChatbotRefs;
}
export async function createVerifiedMarketingService(deps: MarketingProductionServiceDeps): Promise<MarketingService> {
  if (!deps || !deps.pool || typeof deps.pool.connect !== 'function') throw new Error('marketing: production PostgreSQL pool required');
  if (!deps.campaigns || typeof deps.campaigns.campaignExists !== 'function') throw new Error('marketing: campaign reference adapter required');
  if (!deps.chatbots || typeof deps.chatbots.chatbotExists !== 'function') throw new Error('marketing: chatbot reference adapter required');
  await requireMarketingSchema(deps.schemaProbe);
  return createMarketingService({
    store: createSqlMarketingStore({pool:deps.pool}),
    campaigns:deps.campaigns,
    chatbots:deps.chatbots,
  });
}
