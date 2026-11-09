/** Read-only product-owned lookup; this is NOT provisioning.
 * The deployed DB must grant EXECUTE on the SQL function only to a
 * restricted application role. Run withTenant when checking other data.
 */
import type{TenantPool} from '../database/tenant-context.ts';
import {withTenant,isCompanyId} from '../database/tenant-context.ts';
const SUBJECT=/^[^\s\x00-\x1f\x7f]{1,256}$/u;
export function createDeskCentralLinkQuery(pool:TenantPool){
 if(typeof pool?.connect!=='function')throw TypeError('trusted tenant pool required');
 return async(issuer:string,subject:string,companyId:string)=>{
  if(!isCompanyId(companyId)||typeof issuer!=='string'||typeof subject!=='string'||
   !SUBJECT.test(subject)||issuer.length>256)return [];
  try{return await withTenant(pool,companyId,async client=>{
   const rows=await client.query(
    'SELECT user_id,company_id,role,revision,is_active FROM app_central_desk_resolve_link($1,$2,$3::uuid)',
    [issuer,subject,companyId]);
   return rows.rows??[];
  })}catch{return []}
 };
}
