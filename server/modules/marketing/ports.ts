/*
 * Ports for marketing. Every store method takes companyId and scopes to it.
 * CampaignRefs and ChatbotRefs are read-only checks against modules this one does not own.
 */
import type { ContentItem, ContentKind, ContentStatus, LandingPage, PageStatus } from './types.ts';

export interface PagePatch {
  title?: string;
  sections?: LandingPage['sections'];
  campaignId?: string | null;
  chatbotId?: string | null;
  status?: PageStatus;
  publishedAt?: Date | null;
  updatedAt: Date;
}

export interface ContentPatch {
  title?: string;
  body?: string;
  campaignId?: string | null;
  status?: ContentStatus;
  publishedAt?: Date | null;
  updatedAt: Date;
}

export interface MarketingStore {
  insertPage(page: LandingPage): Promise<void>;
  findPage(companyId: string, id: string): Promise<LandingPage | null>;
  findPageBySlug(companyId: string, slug: string): Promise<LandingPage | null>;
  updatePage(companyId: string, id: string, patch: PagePatch): Promise<LandingPage | null>;
  listPages(companyId: string, filter: { status?: PageStatus; campaignId?: string }): Promise<LandingPage[]>;

  insertContent(item: ContentItem): Promise<void>;
  findContent(companyId: string, id: string): Promise<ContentItem | null>;
  updateContent(companyId: string, id: string, patch: ContentPatch): Promise<ContentItem | null>;
  listContent(companyId: string, filter: { kind?: ContentKind; status?: ContentStatus; campaignId?: string }): Promise<ContentItem[]>;
}

/** Answers "does this campaign exist in this company". Backed by the campaigns module. */
export interface CampaignRefs {
  campaignExists(companyId: string, campaignId: string): Promise<boolean>;
}

/** Answers "does this chatbot exist in this company". Backed by the chatbot module's storage. */
export interface ChatbotRefs {
  chatbotExists(companyId: string, chatbotId: string): Promise<boolean>;
}
