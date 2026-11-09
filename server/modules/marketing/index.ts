/*
 * Marketing module entry point. Not mounted: server/routes.ts and index.ts are untouched.
 * Chatbot pages reuse server/modules/chatbot/. Pass a ChatbotRefs adapter over the chatbot
 * module's storage (findChatbot) and do not copy chatbot config here.
 */
export { createMarketingService, MarketingError, assertSections } from './marketing-service.ts';
export type { MarketingService, MarketingServiceDeps, MarketingErrorCode, PageInput, PagePatchInput, ContentInput } from './marketing-service.ts';
export { InMemoryMarketingStore, InMemoryRefs } from './memory-adapter.ts';
export { createDrizzleMarketingStore } from './drizzle-adapter.ts';
export { createSqlMarketingStore, type MarketingSqlOptions } from './sql-store.ts';
export { verifyMarketingSchema, requireMarketingSchema, type MarketingReadiness, type MarketingSchemaProbe } from './schema-readiness.ts';
export { postgresPolicyRoles, tenantPredicate, inspectMarketingPolicies, type MarketingPolicyRow } from './policy-inspection.ts';
export { createVerifiedMarketingService, type MarketingProductionServiceDeps } from './production-service.ts';
export type { MarketingStore, CampaignRefs, ChatbotRefs } from './ports.ts';
export * from './types.ts';
export { createMarketingRouter, type MarketingRouterDeps } from './marketing-router.ts';
export { createMarketingRouterForProduction, type MarketingProductionRouterDeps } from './production-router.ts';
// Production routers verify all required MarketingService operations before accepting the dependency.
