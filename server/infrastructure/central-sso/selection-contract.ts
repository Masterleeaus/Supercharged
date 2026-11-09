/** Server-verified Central decision only. Do not accept raw browser fields.
 * No implicit user/email matching and no automatic tenant provisioning.
 */
import {isCompanyId} from '../database/tenant-context';
export type VerifiedDeskCentralSelection={issuer:string;subject:string;companyId:string;
 audience:'supercharged';authority:'central-verified';verifiedAt:string};
export function isVerifiedDeskCentralSelection(input:unknown,now=Date.now()):input is VerifiedDeskCentralSelection{
 if(!input||typeof input!=='object'||Array.isArray(input))return false;
 const x=input as Record<string,unknown>;
 if(Object.keys(x).sort().join(',')!=='audience,authority,companyId,issuer,subject,verifiedAt')return false;
 if(x.audience!=='supercharged'||x.authority!=='central-verified'||!isCompanyId(x.companyId)||
 typeof x.issuer!=='string'||typeof x.subject!=='string'||
 !/^[^\s\x00-\x1f\x7f]{1,256}$/u.test(x.subject)||
 typeof x.verifiedAt!=='string'||!Number.isFinite(Date.parse(x.verifiedAt))||
 Math.abs(now-Date.parse(x.verifiedAt))>120000)return false;
 try{const u=new URL(x.issuer);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&!u.search&&
 (u.href===x.issuer||u.origin===x.issuer)}catch{return false}
}
