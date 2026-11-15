/** Resolves the company for a Central session from the verified org claim and a live membership row.
 * Issue #195. Central owns membership; Supercharged keeps a tenant key on its own rows.
 * Depends on the company_memberships table (migration 0016, on claude/workforce-security). Lane B
 * (claude/lane-B-tenancy) has no membership table yet; reconcile the name when lane B lands.
 * Fail closed: any missing, revoked, unmapped or erroring lookup returns null.
 */
import {isCompanyId} from '../database/tenant-context.ts';

export const MEMBERSHIP_TABLE='company_memberships';
export const MEMBERSHIP_SQL=`SELECT 1 FROM ${MEMBERSHIP_TABLE} WHERE company_id = $1::uuid AND user_id = $2 LIMIT 1`;

const ID_RE=/^[^\s\x00-\x1f\x7f]{1,256}$/u;

export type SessionTenant={userId:string;companyId:string};
export type MembershipQuery=(sql:string,params:unknown[])=>Promise<Array<Record<string,unknown>>>;

export function createMembershipGate({query}:{query:MembershipQuery}){
 if(typeof query!=='function')throw new TypeError('trusted membership query required');
 return async function hasActiveMembership(companyId:string,userId:string):Promise<boolean>{
  if(!isCompanyId(companyId)||typeof userId!=='string'||!ID_RE.test(userId))return false;
  try{
   const rows=await query(MEMBERSHIP_SQL,[companyId,userId]);
   return Array.isArray(rows)&&rows.length===1;
  }catch{return false}
 };
}

/** The company comes only from the verified org claim mapped server-side. Never from request input. */
export function createSessionTenantResolver({resolveCompanyForOrg,hasActiveMembership}:{
 resolveCompanyForOrg:(orgClaim:string)=>Promise<string|null>;
 hasActiveMembership:(companyId:string,userId:string)=>Promise<boolean>;
}){
 if(typeof resolveCompanyForOrg!=='function'||typeof hasActiveMembership!=='function')
  throw new TypeError('trusted tenant dependencies required');
 return async function resolveSessionTenant(verified:{orgClaim:string;userId:string}):Promise<SessionTenant|null>{
  if(!verified||typeof verified.orgClaim!=='string'||!ID_RE.test(verified.orgClaim)||
   typeof verified.userId!=='string'||!ID_RE.test(verified.userId))return null;
  try{
   const companyId=await resolveCompanyForOrg(verified.orgClaim);
   if(!isCompanyId(companyId))return null;
   if(await hasActiveMembership(companyId,verified.userId)!==true)return null;
   return {userId:verified.userId,companyId};
  }catch{return null}
 };
}
