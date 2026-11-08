/*
 * In-memory adapters for tests and local runs. Every read filters on companyId first.
 * The reference checks are fakes: a test seeds the ids that "exist" in each company.
 */
import type { CampaignRefs, ChatbotRefs, MarketingStore, PagePatch, ContentPatch } from './ports.ts';
import type { ContentItem, ContentKind, ContentStatus, LandingPage, PageStatus } from './types.ts';

function requireCo(companyId: string): string {
  if (typeof companyId !== 'string' || companyId.trim() === '') throw new TypeError('marketing: companyId is required');
  return companyId;
}

const clone = <T extends object>(value: T): T => ({ ...value });

export class InMemoryMarketingStore implements MarketingStore {
  private readonly pages: LandingPage[] = [];
  private readonly content: ContentItem[] = [];

  async insertPage(page: LandingPage): Promise<void> {
    requireCo(page.companyId);
    this.pages.push(clone(page));
  }

  async findPage(companyId: string, id: string): Promise<LandingPage | null> {
    const found = this.pages.find((p) => p.companyId === requireCo(companyId) && p.id === id);
    return found ? clone(found) : null;
  }

  async findPageBySlug(companyId: string, slug: string): Promise<LandingPage | null> {
    const found = this.pages.find((p) => p.companyId === requireCo(companyId) && p.slug === slug);
    return found ? clone(found) : null;
  }

  async updatePage(companyId: string, id: string, patch: PagePatch): Promise<LandingPage | null> {
    const row = this.pages.find((p) => p.companyId === requireCo(companyId) && p.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return clone(row);
  }

  async listPages(companyId: string, filter: { status?: PageStatus; campaignId?: string }): Promise<LandingPage[]> {
    return this.pages
      .filter((p) => p.companyId === requireCo(companyId))
      .filter((p) => (filter.status ? p.status === filter.status : true))
      .filter((p) => (filter.campaignId ? p.campaignId === filter.campaignId : true))
      .map(clone);
  }

  async insertContent(item: ContentItem): Promise<void> {
    requireCo(item.companyId);
    this.content.push(clone(item));
  }

  async findContent(companyId: string, id: string): Promise<ContentItem | null> {
    const found = this.content.find((c) => c.companyId === requireCo(companyId) && c.id === id);
    return found ? clone(found) : null;
  }

  async updateContent(companyId: string, id: string, patch: ContentPatch): Promise<ContentItem | null> {
    const row = this.content.find((c) => c.companyId === requireCo(companyId) && c.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return clone(row);
  }

  async listContent(companyId: string, filter: { kind?: ContentKind; status?: ContentStatus; campaignId?: string }): Promise<ContentItem[]> {
    return this.content
      .filter((c) => c.companyId === requireCo(companyId))
      .filter((c) => (filter.kind ? c.kind === filter.kind : true))
      .filter((c) => (filter.status ? c.status === filter.status : true))
      .filter((c) => (filter.campaignId ? c.campaignId === filter.campaignId : true))
      .map(clone);
  }
}

/** Seeded set of "<companyId>:<id>" keys that exist. Used for both campaign and chatbot refs. */
export class InMemoryRefs implements CampaignRefs, ChatbotRefs {
  private readonly known = new Set<string>();

  seed(companyId: string, id: string): void {
    this.known.add(`${requireCo(companyId)}:${id}`);
  }

  async campaignExists(companyId: string, campaignId: string): Promise<boolean> {
    return this.known.has(`${requireCo(companyId)}:${campaignId}`);
  }

  async chatbotExists(companyId: string, chatbotId: string): Promise<boolean> {
    return this.known.has(`${requireCo(companyId)}:${chatbotId}`);
  }
}
