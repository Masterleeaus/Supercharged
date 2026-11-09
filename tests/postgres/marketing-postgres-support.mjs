/** Real PostgreSQL fixture for CI-only Marketing tenant isolation tests. */
import pg from 'pg';
import { createSqlMarketingStore } from '../../server/modules/marketing/sql-store.ts';
export const A='11111111-1111-4111-8111-111111111111';
export const B='22222222-2222-4222-8222-222222222222';
export const NOW=new Date('2026-11-09T00:00:00.000Z');
export const enabled = Boolean(process.env.MARKETING_PG_INTEGRATION_URL) &&
  process.env.MARKETING_PG_DISPOSABLE === 'true';
export function createFixture() {
 if (!enabled) throw new Error('PostgreSQL Marketing fixture must be explicitly enabled');
 const pool=new pg.Pool({ connectionString:process.env.MARKETING_PG_INTEGRATION_URL, max:8 });
 return {pool,store:createSqlMarketingStore({pool}),close:()=>pool.end()};
}
export function page(companyId,id,slug=id) {return {
 id,companyId,slug,title:'Integration page',status:'draft',sections:[{kind:'text',props:{body:'Original'}}],
 campaignId:null,chatbotId:null,authorKind:'human',authorId:'tester',publishedAt:null,createdAt:NOW,updatedAt:NOW,
};}
export function content(companyId,id) {return {
 id,companyId,kind:'blog_post',title:'Integration story',body:'Original content',status:'draft',
 campaignId:null,authorKind:'human',authorId:'tester',publishedAt:null,createdAt:NOW,updatedAt:NOW,
};}
