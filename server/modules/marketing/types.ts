/*
 * Marketing types: landing pages and content records. Each one may reference a campaign
 * (owned by the campaigns module) and, for pages, a chatbot (owned by the chatbot module).
 * This module stores only the reference. It never copies chatbot config. Every entity
 * carries company_id. Types and constants only.
 */

export const PAGE_STATUSES = ['draft', 'published', 'archived'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const CONTENT_KINDS = ['blog_post', 'social_post', 'email_copy', 'ad_copy'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const CONTENT_STATUSES = ['draft', 'approved', 'published', 'archived'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const SECTION_KINDS = ['hero', 'text', 'cta', 'faq', 'image'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** Structured content only. Values are plain text, numbers, booleans or string lists. No raw HTML. */
export type SectionValue = string | number | boolean | string[];

export interface PageSection {
  kind: SectionKind;
  props: Record<string, SectionValue>;
}

export interface LandingPage {
  companyId: string;
  id: string;
  slug: string;
  title: string;
  status: PageStatus;
  sections: PageSection[];
  /** Reference to a campaign in the campaigns module. Null when the page is not tied to one. */
  campaignId: string | null;
  /** Reference to a chatbot in the chatbot module. The widget config lives there. */
  chatbotId: string | null;
  authorKind: 'human' | 'agent';
  authorId: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentItem {
  companyId: string;
  id: string;
  kind: ContentKind;
  title: string;
  /** Markdown or plain text. The renderer escapes it. */
  body: string;
  status: ContentStatus;
  campaignId: string | null;
  authorKind: 'human' | 'agent';
  authorId: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Verified caller. Comes from the session or agent runtime, never from request input. */
export interface Actor {
  kind: 'human' | 'agent';
  id: string;
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_CONTENT_BODY_LENGTH = 50000;
export const MAX_SECTIONS = 50;
export const MAX_SECTION_TEXT = 2000;
