/*
 * Drizzle placeholder. Every method throws until migrations/DRAFT_campaigns.sql is promoted
 * and the tables are wired into the Drizzle schema. transitionJob must become
 * UPDATE ... WHERE id = ? AND company_id = ? AND status = ? when that happens.
 */
import type { CampaignStore } from './ports.ts';

const NOT_READY =
  'campaigns: Drizzle storage is not available. Promote migrations/DRAFT_campaigns.sql and wire the tables before use.';

const notReady = async (..._args: unknown[]): Promise<never> => {
  throw new Error(NOT_READY);
};

export function createDrizzleCampaignStore(): CampaignStore {
  return {
    insertContact: notReady,
    findContactByAddress: notReady,
    listContacts: notReady,
    insertAudience: notReady,
    findAudience: notReady,
    insertCampaign: notReady,
    findCampaign: notReady,
    updateCampaign: notReady,
    insertStep: notReady,
    findStep: notReady,
    listSteps: notReady,
    insertOptIn: notReady,
    listOptIns: notReady,
    hasActiveOptIn: notReady,
    upsertUnsubscribe: notReady,
    findUnsubscribe: notReady,
    listUnsubscribes: notReady,
    insertJobs: notReady,
    findJob: notReady,
    listJobs: notReady,
    transitionJob: notReady,
  } as CampaignStore;
}
