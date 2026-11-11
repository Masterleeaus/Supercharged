/** PostgreSQL rows for the archived draft Marketing schema. Keep this mapping explicit. */
import type { LandingPage, ContentItem } from './types.ts';
type Row = Record<string, any>;
export const PAGE_COLUMNS = 'id, company_id, slug, title, status, sections, campaign_id, chatbot_id, author_kind, author_id, published_at, created_at, updated_at';
export const CONTENT_COLUMNS = 'id, company_id, kind, title, body, status, campaign_id, author_kind, author_id, published_at, created_at, updated_at';
function date(value: unknown): Date { return value instanceof Date ? value : new Date(String(value)); }
function optionalDate(value: unknown): Date | null { return value == null ? null : date(value); }
export function pageFromSql(row: Row): LandingPage {
 const sections = typeof row.sections === 'string' ? JSON.parse(row.sections) : row.sections;
 return {id:row.id,companyId:row.company_id,slug:row.slug,title:row.title,status:row.status,
  sections: sections ?? [],campaignId:row.campaign_id ?? null,chatbotId:row.chatbot_id ?? null,
  authorKind:row.author_kind,authorId:row.author_id,publishedAt:optionalDate(row.published_at),
  createdAt:date(row.created_at),updatedAt:date(row.updated_at)};
}
export function contentFromSql(row: Row): ContentItem {
 return {id:row.id,companyId:row.company_id,kind:row.kind,title:row.title,body:row.body,status:row.status,
  campaignId:row.campaign_id ?? null,authorKind:row.author_kind,authorId:row.author_id,
  publishedAt:optionalDate(row.published_at),createdAt:date(row.created_at),updatedAt:date(row.updated_at)};
}
