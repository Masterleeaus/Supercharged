/*
 * Marketing service. Landing pages and content records. Pure logic over injected ports.
 *
 * Rules:
 *   - Agents may create and edit drafts. Only a human may approve, publish or archive.
 *   - Publishing a page or content item is not a send, so it does not use the approvals
 *     gate. The human-only rule replaces it. Decision for review.
 *   - A campaign or chatbot reference must exist in the same company. The module stores
 *     the reference only.
 *   - Landing page sections are structured data. Angle brackets are refused, so no raw
 *     HTML reaches a page.
 */
import { randomUUID } from 'node:crypto';
import { requireCompanyId } from '../chatbot/chatbot-scope.ts';
import type { CampaignRefs, ChatbotRefs, MarketingStore } from './ports.ts';
import {
  CONTENT_KINDS,
  MAX_CONTENT_BODY_LENGTH,
  MAX_SECTIONS,
  MAX_SECTION_TEXT,
  MAX_TITLE_LENGTH,
  SECTION_KINDS,
  type Actor,
  type ContentItem,
  type ContentKind,
  type ContentStatus,
  type LandingPage,
  type PageSection,
  type PageStatus,
  type SectionValue,
} from './types.ts';

export type MarketingErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict';

export class MarketingError extends Error {
  readonly code: MarketingErrorCode;

  constructor(message: string, code: MarketingErrorCode) {
    super(message);
    this.name = 'MarketingError';
    this.code = code;
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TITLE_LENGTH) {
    throw new MarketingError(`title must be a non-empty string up to ${MAX_TITLE_LENGTH} chars`, 'invalid');
  }
  return value;
}

function assertSlug(value: unknown): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 80 || !SLUG.test(value)) {
    throw new MarketingError('slug must be 2 to 80 chars of lowercase letters, digits and single hyphens', 'invalid');
  }
  return value;
}

function assertOptionalRef(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new MarketingError(`${field} must be a non-empty string up to 200 chars`, 'invalid');
  }
  return value;
}

function assertSectionValue(value: unknown, key: string): SectionValue {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  const text = (s: unknown): s is string => typeof s === 'string' && s.length <= MAX_SECTION_TEXT;
  if (text(value)) {
    if (/[<>]/.test(value)) throw new MarketingError(`section prop "${key}" must not contain < or >`, 'invalid');
    return value;
  }
  if (Array.isArray(value) && value.length <= 50 && value.every(text)) {
    if (value.some((v) => /[<>]/.test(v))) throw new MarketingError(`section prop "${key}" must not contain < or >`, 'invalid');
    return value as string[];
  }
  throw new MarketingError(`section prop "${key}" must be text, a number, a boolean or a list of text`, 'invalid');
}

export function assertSections(value: unknown): PageSection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SECTIONS) {
    throw new MarketingError(`sections must be an array of up to ${MAX_SECTIONS} items`, 'invalid');
  }
  return value.map((raw, i): PageSection => {
    if (typeof raw !== 'object' || raw === null) throw new MarketingError(`sections[${i}] must be an object`, 'invalid');
    const kind = (raw as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !(SECTION_KINDS as readonly string[]).includes(kind)) {
      throw new MarketingError(`sections[${i}].kind must be one of ${SECTION_KINDS.join(', ')}`, 'invalid');
    }
    const propsRaw = (raw as { props?: unknown }).props ?? {};
    if (typeof propsRaw !== 'object' || propsRaw === null || Array.isArray(propsRaw)) {
      throw new MarketingError(`sections[${i}].props must be an object`, 'invalid');
    }
    const props: Record<string, SectionValue> = {};
    for (const [key, v] of Object.entries(propsRaw)) {
      if (key.length === 0 || key.length > 64 || key === '__proto__') throw new MarketingError(`sections[${i}] has an invalid prop name`, 'invalid');
      props[key] = assertSectionValue(v, key);
    }
    return { kind: kind as PageSection['kind'], props };
  });
}

function assertContentBody(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_CONTENT_BODY_LENGTH) {
    throw new MarketingError(`body must be a non-empty string up to ${MAX_CONTENT_BODY_LENGTH} chars`, 'invalid');
  }
  return value;
}

export interface MarketingServiceDeps {
  store: MarketingStore;
  campaigns: CampaignRefs;
  chatbots: ChatbotRefs;
  now?: () => Date;
  newId?: () => string;
}

export interface PageInput {
  slug: unknown;
  title: unknown;
  sections?: unknown;
  campaignId?: unknown;
  chatbotId?: unknown;
}

export interface PagePatchInput {
  title?: unknown;
  sections?: unknown;
  campaignId?: unknown;
  chatbotId?: unknown;
}

export interface ContentInput {
  kind: unknown;
  title: unknown;
  body: unknown;
  campaignId?: unknown;
}

export interface MarketingService {
  createPage(companyId: string, actor: Actor, input: PageInput): Promise<LandingPage>;
  updatePage(companyId: string, actor: Actor, pageId: string, input: PagePatchInput): Promise<LandingPage>;
  publishPage(companyId: string, actor: Actor, pageId: string): Promise<LandingPage>;
  archivePage(companyId: string, actor: Actor, pageId: string): Promise<LandingPage>;
  getPage(companyId: string, pageId: string): Promise<LandingPage>;
  listPages(companyId: string, filter?: { status?: PageStatus; campaignId?: string }): Promise<LandingPage[]>;

  createContent(companyId: string, actor: Actor, input: ContentInput): Promise<ContentItem>;
  updateContent(companyId: string, actor: Actor, id: string, input: Partial<ContentInput>): Promise<ContentItem>;
  approveContent(companyId: string, actor: Actor, id: string): Promise<ContentItem>;
  publishContent(companyId: string, actor: Actor, id: string): Promise<ContentItem>;
  getContent(companyId: string, id: string): Promise<ContentItem>;
  listContent(companyId: string, filter?: { kind?: ContentKind; status?: ContentStatus; campaignId?: string }): Promise<ContentItem[]>;
}

export function createMarketingService(deps: MarketingServiceDeps): MarketingService {
  const { store, campaigns, chatbots } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  async function checkCampaign(companyId: string, campaignId: string | null): Promise<void> {
    if (campaignId !== null && !(await campaigns.campaignExists(companyId, campaignId))) {
      throw new MarketingError('Campaign not found in this company', 'not_found');
    }
  }

  async function checkChatbot(companyId: string, chatbotId: string | null): Promise<void> {
    if (chatbotId !== null && !(await chatbots.chatbotExists(companyId, chatbotId))) {
      throw new MarketingError('Chatbot not found in this company', 'not_found');
    }
  }

  async function loadPage(companyId: string, id: string): Promise<LandingPage> {
    const page = await store.findPage(companyId, id);
    if (!page) throw new MarketingError('Page not found', 'not_found');
    return page;
  }

  async function loadContent(companyId: string, id: string): Promise<ContentItem> {
    const item = await store.findContent(companyId, id);
    if (!item) throw new MarketingError('Content not found', 'not_found');
    return item;
  }

  function requireHuman(actor: Actor, verb: string): void {
    if (actor.kind !== 'human') throw new MarketingError(`Only a human may ${verb}`, 'forbidden');
  }

  return {
    async createPage(rawCompanyId, actor, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const slug = assertSlug(input.slug);
      if (await store.findPageBySlug(companyId, slug)) throw new MarketingError('A page with this slug already exists', 'conflict');
      const campaignId = assertOptionalRef(input.campaignId, 'campaignId');
      const chatbotId = assertOptionalRef(input.chatbotId, 'chatbotId');
      await checkCampaign(companyId, campaignId);
      await checkChatbot(companyId, chatbotId);

      const at = now();
      const page: LandingPage = {
        companyId,
        id: newId(),
        slug,
        title: assertTitle(input.title),
        status: 'draft',
        sections: assertSections(input.sections),
        campaignId,
        chatbotId,
        authorKind: actor.kind,
        authorId: actor.id,
        publishedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      try {
        await store.insertPage(page);
      } catch (error: unknown) {
        // The database unique key closes the race between findPageBySlug and insertPage.
        if (error instanceof Error && (error as { code?: unknown }).code === '23505' &&
            (error as { constraint?: unknown }).constraint === 'landing_pages_company_slug_uidx') {
          throw new MarketingError('A page with this slug already exists', 'conflict');
        }
        throw error;
      }
      return page;
    },

    async updatePage(rawCompanyId, _actor, pageId, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const page = await loadPage(companyId, pageId);
      if (page.status !== 'draft') throw new MarketingError('Only a draft page can be edited', 'conflict');
      const patch: Parameters<MarketingStore['updatePage']>[2] = { updatedAt: now() };
      if (input.title !== undefined) patch.title = assertTitle(input.title);
      if (input.sections !== undefined) patch.sections = assertSections(input.sections);
      if (input.campaignId !== undefined) {
        patch.campaignId = assertOptionalRef(input.campaignId, 'campaignId');
        await checkCampaign(companyId, patch.campaignId);
      }
      if (input.chatbotId !== undefined) {
        patch.chatbotId = assertOptionalRef(input.chatbotId, 'chatbotId');
        await checkChatbot(companyId, patch.chatbotId);
      }
      const changed = await store.updatePage(companyId, page.id, patch);
      if (!changed) throw new MarketingError('Page changed before the update completed', 'conflict');
      return changed;
    },

    async publishPage(rawCompanyId, actor, pageId) {
      const companyId = requireCompanyId(rawCompanyId);
      requireHuman(actor, 'publish a page');
      const page = await loadPage(companyId, pageId);
      if (page.status !== 'draft') throw new MarketingError(`Page is ${page.status}`, 'conflict');
      const at = now();
      const changed = await store.updatePage(companyId, page.id, { status: 'published', publishedAt: at, updatedAt: at });
      if (!changed) throw new MarketingError('Page is no longer a publishable draft', 'conflict');
      return changed;
    },

    async archivePage(rawCompanyId, actor, pageId) {
      const companyId = requireCompanyId(rawCompanyId);
      requireHuman(actor, 'archive a page');
      const page = await loadPage(companyId, pageId);
      if (page.status === 'archived') throw new MarketingError('Page is already archived', 'conflict');
      const changed = await store.updatePage(companyId, page.id, { status: 'archived', updatedAt: now() });
      if (!changed) throw new MarketingError('Page status changed before archiving', 'conflict');
      return changed;
    },

    async getPage(rawCompanyId, pageId) {
      return loadPage(requireCompanyId(rawCompanyId), pageId);
    },

    async listPages(rawCompanyId, filter = {}) {
      return store.listPages(requireCompanyId(rawCompanyId), filter);
    },

    async createContent(rawCompanyId, actor, input) {
      const companyId = requireCompanyId(rawCompanyId);
      if (typeof input.kind !== 'string' || !(CONTENT_KINDS as readonly string[]).includes(input.kind)) {
        throw new MarketingError(`kind must be one of ${CONTENT_KINDS.join(', ')}`, 'invalid');
      }
      const campaignId = assertOptionalRef(input.campaignId, 'campaignId');
      await checkCampaign(companyId, campaignId);
      const at = now();
      const item: ContentItem = {
        companyId,
        id: newId(),
        kind: input.kind as ContentKind,
        title: assertTitle(input.title),
        body: assertContentBody(input.body),
        status: 'draft',
        campaignId,
        authorKind: actor.kind,
        authorId: actor.id,
        publishedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      await store.insertContent(item);
      return item;
    },

    async updateContent(rawCompanyId, _actor, id, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const item = await loadContent(companyId, id);
      if (item.status !== 'draft') throw new MarketingError('Only a draft can be edited', 'conflict');
      const patch: Parameters<MarketingStore['updateContent']>[2] = { updatedAt: now() };
      if (input.title !== undefined) patch.title = assertTitle(input.title);
      if (input.body !== undefined) patch.body = assertContentBody(input.body);
      if (input.campaignId !== undefined) {
        patch.campaignId = assertOptionalRef(input.campaignId, 'campaignId');
        await checkCampaign(companyId, patch.campaignId);
      }
      const changed = await store.updateContent(companyId, item.id, patch);
      if (!changed) throw new MarketingError('Content changed before the update completed', 'conflict');
      return changed;
    },

    async approveContent(rawCompanyId, actor, id) {
      const companyId = requireCompanyId(rawCompanyId);
      requireHuman(actor, 'approve content');
      const item = await loadContent(companyId, id);
      if (item.status !== 'draft') throw new MarketingError(`Content is ${item.status}`, 'conflict');
      const changed = await store.updateContent(companyId, item.id, { status: 'approved', updatedAt: now() });
      if (!changed) throw new MarketingError('Content is no longer a draft', 'conflict');
      return changed;
    },

    async publishContent(rawCompanyId, actor, id) {
      const companyId = requireCompanyId(rawCompanyId);
      requireHuman(actor, 'publish content');
      const item = await loadContent(companyId, id);
      if (item.status !== 'approved') throw new MarketingError('Content must be approved before it is published', 'conflict');
      const at = now();
      const changed = await store.updateContent(companyId, item.id, { status: 'published', publishedAt: at, updatedAt: at });
      if (!changed) throw new MarketingError('Content is no longer approved for publication', 'conflict');
      return changed;
    },

    async getContent(rawCompanyId, id) {
      return loadContent(requireCompanyId(rawCompanyId), id);
    },

    async listContent(rawCompanyId, filter = {}) {
      return store.listContent(requireCompanyId(rawCompanyId), filter);
    },
  };
}

