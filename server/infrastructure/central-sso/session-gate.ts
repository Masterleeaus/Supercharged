/** Uses Supercharged's existing native company-scoped JWT issuer.
 * Caller MUST verify local user active status and current company scope.
 * This gate does not enable SSO or bypass existing native login.
 */
import type{DeskAccount} from './account-resolver.ts';
export function createDeskCentralSessionGate({
 resolve,issueNativeToken
}:{
 resolve:(identity:unknown)=>Promise<DeskAccount|null>;
 issueNativeToken:(userId:string,role:string,companyId:string)=>Promise<string>;
}){
 if(typeof resolve!=='function'||typeof issueNativeToken!=='function')
 throw new TypeError('trusted Supercharged session issuer required');
 return async(identity:unknown):Promise<string|null>=>{
  const resolved=await resolve(identity);
  if(!resolved)return null;
  try{
   const token=await issueNativeToken(resolved.userId,resolved.role,resolved.companyId);
   return typeof token==='string'&&token.length>=32&&token.length<=8192&&!/\s/.test(token)?token:null;
  }catch{return null}
 };
}
