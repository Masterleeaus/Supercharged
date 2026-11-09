/** Resolve an already-provisioned local user through a tenant-fixed
 * database lookup and independent current Central entitlement check.
 */
import {isVerifiedDeskCentralSelection,type VerifiedDeskCentralSelection} from './selection-contract.ts';
import {isCompanyId} from '../database/tenant-context.ts';
const SUBJECT=/^[^\s\x00-\x1f\x7f]{1,256}$/u;
export type DeskAccount={userId:string;companyId:string;role:string;revision:number};
type LinkRow={user_id:string;company_id:string;role:string;revision:number|string;is_active:boolean};
export function createDeskCentralAccountResolver({
 authoriseCentral,queryLink,resolveCompanyBinding,clock=()=>Date.now()
}:{
 authoriseCentral:(input:VerifiedDeskCentralSelection)=>Promise<boolean>;
 queryLink:(issuer:string,subject:string,companyId:string)=>Promise<LinkRow[]>;
 resolveCompanyBinding:(companyId:string)=>Promise<string|null>;
 clock?:()=>number;
}){
 if(typeof authoriseCentral!=='function'||typeof queryLink!=='function'||
 typeof resolveCompanyBinding!=='function'||typeof clock!=='function')
 throw new TypeError('trusted Supercharged account dependencies required');
 return async(input:unknown):Promise<DeskAccount|null>=>{
  if(!isVerifiedDeskCentralSelection(input,clock()))return null;
  try{
   const mapped=await resolveCompanyBinding(input.companyId);
   if(mapped!==input.companyId||!isCompanyId(mapped)||await authoriseCentral(input)!==true)return null;
   const rows=await queryLink(input.issuer,input.subject,input.companyId);
   if(!Array.isArray(rows)||rows.length!==1)return null;
   const row=rows[0],revision=Number(row.revision);
   if(row.company_id!==input.companyId||row.is_active!==true||
      typeof row.user_id!=='string'||!SUBJECT.test(row.user_id)||
      typeof row.role!=='string'||!SUBJECT.test(row.role)||
      !Number.isSafeInteger(revision)||revision<1)return null;
   return {userId:row.user_id,companyId:row.company_id,role:row.role,revision};
  }catch{return null}
 };
}
