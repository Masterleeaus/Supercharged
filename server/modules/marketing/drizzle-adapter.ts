/*
 * Drizzle placeholder. Every method throws until migrations/DRAFT_marketing.sql is promoted
 * and the tables are wired into the Drizzle schema.
 */
import type { MarketingStore } from './ports.ts';

const NOT_READY =
  'marketing: Drizzle storage is not available. Promote migrations/DRAFT_marketing.sql and wire the tables before use.';

const notReady = async (..._args: unknown[]): Promise<never> => {
  throw new Error(NOT_READY);
};

export function createDrizzleMarketingStore(): MarketingStore {
  return {
    insertPage: notReady,
    findPage: notReady,
    findPageBySlug: notReady,
    updatePage: notReady,
    listPages: notReady,
    insertContent: notReady,
    findContent: notReady,
    updateContent: notReady,
    listContent: notReady,
  } as MarketingStore;
}
