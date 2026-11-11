/** Fixed allowlisted SQL columns for Marketing updates. Never interpolate caller-supplied field names. */
import type { PagePatch, ContentPatch } from './ports.ts';
export interface SqlPatch { assignments: string; params: unknown[]; }
function compile(input: Record<string, unknown>, allowed: readonly [string,string, boolean?][]): SqlPatch {
 const params:unknown[]=[];
 const sets:string[]=[];
 for (const [field,column,json] of allowed){
  if (input[field] !== undefined){
   params.push(json ? JSON.stringify(input[field]) : input[field]);
   sets.push(`${column} = $${params.length + 2}${json ? '::jsonb' : ''}`);
  }
 }
 return {assignments:sets.join(', '),params};
}
export function pageSqlPatch(patch:PagePatch):SqlPatch {
 return compile(patch as unknown as Record<string,unknown>,[
  ['title','title'],['sections','sections',true],['campaignId','campaign_id'],
  ['chatbotId','chatbot_id'],['status','status'],['publishedAt','published_at'],['updatedAt','updated_at']]);
}
export function contentSqlPatch(patch:ContentPatch):SqlPatch {
 return compile(patch as unknown as Record<string,unknown>,[
  ['title','title'],['body','body'],['campaignId','campaign_id'],
  ['status','status'],['publishedAt','published_at'],['updatedAt','updated_at']]);
}
