/**
 * Parameterised PostgreSQL MarketingStore. Every operation is executed via withTenant:
 * transaction-scoped app.company_id and restricted role. SQL always has a company_id predicate.
 * Caller must apply/review archived DRAFT_marketing.sql as a numbered migration first.
 * No schema promotion or production activation happens in this module.
 */
import { assertCompanyId, withTenant, type TenantPool, type TenantQueryClient } from '../../infrastructure/database/tenant-context.ts';
import type { MarketingStore, PagePatch, ContentPatch } from './ports.ts';
import type { LandingPage, ContentItem, ContentKind, ContentStatus, PageStatus } from './types.ts';
import { PAGE_COLUMNS, CONTENT_COLUMNS, pageFromSql, contentFromSql } from './sql-row.ts';
import { pageSqlPatch, contentSqlPatch } from './sql-patch.ts';
export interface MarketingSqlOptions { pool: TenantPool; }
const one=<T>(rows:T[],fn:(r:T)=>any)=>rows.length ? fn(rows[0]) : null;
export function createSqlMarketingStore({pool}:MarketingSqlOptions):MarketingStore {
 if (!pool || typeof pool.connect!=='function') throw new Error('marketing: a tenant-capable PostgreSQL pool is required');
 const scoped=<T>(companyId:string,fn:(db:TenantQueryClient)=>Promise<T>)=>withTenant(pool,assertCompanyId(companyId),fn);
 return {
  async insertPage(page:LandingPage) {
   await scoped(page.companyId,async db=>{
    await db.query(`INSERT INTO landing_pages
     (id,company_id,slug,title,status,sections,campaign_id,chatbot_id,author_kind,author_id,published_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,[
      page.id,page.companyId,page.slug,page.title,page.status,JSON.stringify(page.sections),
      page.campaignId,page.chatbotId,page.authorKind,page.authorId,page.publishedAt,page.createdAt,page.updatedAt]);
   });
  },
  findPage(companyId:string,id:string) {
   return scoped(companyId,async db=>one((await db.query(`SELECT ${PAGE_COLUMNS} FROM landing_pages WHERE company_id = $1 AND id = $2`,[companyId,id])).rows,pageFromSql));
  },
  findPageBySlug(companyId:string,slug:string) {
   return scoped(companyId,async db=>one((await db.query(`SELECT ${PAGE_COLUMNS} FROM landing_pages WHERE company_id = $1 AND slug = $2`,[companyId,slug])).rows,pageFromSql));
  },
  updatePage(companyId:string,id:string,patch:PagePatch) {
   return scoped(companyId,async db=>{
    const compiled=pageSqlPatch(patch);
    if (!compiled.assignments) return one((await db.query(`SELECT ${PAGE_COLUMNS} FROM landing_pages WHERE company_id = $1 AND id = $2`,[companyId,id])).rows,pageFromSql);
    const rows=(await db.query(`UPDATE landing_pages SET ${compiled.assignments} WHERE company_id = $1 AND id = $2 RETURNING ${PAGE_COLUMNS}`,[companyId,id,...compiled.params])).rows;
    return one(rows,pageFromSql);
   });
  },
  listPages(companyId:string,filter:{status?:PageStatus;campaignId?:string}) {
   return scoped(companyId,async db=>{
    const values:unknown[]=[companyId];let where='company_id = $1';
    if (filter?.status!==undefined){values.push(filter.status);where+=` AND status = $${values.length}`;}
    if (filter?.campaignId!==undefined){values.push(filter.campaignId);where+=` AND campaign_id = $${values.length}`;}
    const rows=(await db.query(`SELECT ${PAGE_COLUMNS} FROM landing_pages WHERE ${where} ORDER BY updated_at DESC, id ASC`,values)).rows;
    return rows.map(pageFromSql);
   });
  },
  async insertContent(item:ContentItem) {
   await scoped(item.companyId,async db=>{
    await db.query(`INSERT INTO content_items
     (id,company_id,kind,title,body,status,campaign_id,author_kind,author_id,published_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[
      item.id,item.companyId,item.kind,item.title,item.body,item.status,
      item.campaignId,item.authorKind,item.authorId,item.publishedAt,item.createdAt,item.updatedAt]);
   });
  },
  findContent(companyId:string,id:string) {
   return scoped(companyId,async db=>one((await db.query(`SELECT ${CONTENT_COLUMNS} FROM content_items WHERE company_id = $1 AND id = $2`,[companyId,id])).rows,contentFromSql));
  },
  updateContent(companyId:string,id:string,patch:ContentPatch) {
   return scoped(companyId,async db=>{
    const compiled=contentSqlPatch(patch);
    if (!compiled.assignments) return one((await db.query(`SELECT ${CONTENT_COLUMNS} FROM content_items WHERE company_id = $1 AND id = $2`,[companyId,id])).rows,contentFromSql);
    return one((await db.query(`UPDATE content_items SET ${compiled.assignments} WHERE company_id = $1 AND id = $2 RETURNING ${CONTENT_COLUMNS}`,[companyId,id,...compiled.params])).rows,contentFromSql);
   });
  },
  listContent(companyId:string,filter:{kind?:ContentKind;status?:ContentStatus;campaignId?:string}) {
   return scoped(companyId,async db=>{
    const values:unknown[]=[companyId];let where='company_id = $1';
    if (filter?.kind!==undefined){values.push(filter.kind);where+=` AND kind = $${values.length}`;}
    if (filter?.status!==undefined){values.push(filter.status);where+=` AND status = $${values.length}`;}
    if (filter?.campaignId!==undefined){values.push(filter.campaignId);where+=` AND campaign_id = $${values.length}`;}
    const rows=(await db.query(`SELECT ${CONTENT_COLUMNS} FROM content_items WHERE ${where} ORDER BY updated_at DESC, id ASC`,values)).rows;
    return rows.map(contentFromSql);
   });
  },
 };
}
