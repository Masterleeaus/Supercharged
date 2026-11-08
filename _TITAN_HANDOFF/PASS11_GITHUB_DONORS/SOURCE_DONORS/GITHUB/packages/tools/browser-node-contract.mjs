import { EXECUTION_CLASSES, EXECUTION_STATES, ExecutionError } from './execution-gateway.mjs';

export const BROWSER_SESSION_SCOPES=Object.freeze(['personal','agent','team','company','ephemeral']);
export const BROWSER_ACTIONS=Object.freeze({open:'read',navigate:'read',read:'read',tabs:'read',screenshot:'read',wait:'read',scroll:'read',click:'write',type:'write',select:'write',upload:'write',download:'write',evaluate:'dangerous'});
export function markBrowserObservationUntrusted(observation){return Object.freeze({source:'browser',trust:'untrusted_external',may_define_authority:false,content:observation});}

export function createBrowserNodeProvider({id='browser-node.local',company_id,sessions,allowedDomains=[],blockedDomains=[],executor,verifier}) {
  if(!company_id) throw new ExecutionError('INVALID_BROWSER_NODE','Browser Node requires company_id');
  if(typeof executor!=='function') throw new ExecutionError('INVALID_BROWSER_NODE','Browser Node requires executor');
  if(typeof verifier!=='function') throw new ExecutionError('BROWSER_VERIFIER_REQUIRED','Browser Node requires independent post-action verification');
  return {id,company_id,executionClass:EXECUTION_CLASSES.OPERATED,capabilities:['browser.open','browser.navigate','browser.read','browser.click','browser.type','browser.select','browser.scroll','browser.screenshot','browser.tabs','browser.download','browser.upload','browser.evaluate','browser.wait'],
    async execute(request){
      const action=request.capability.replace('browser.',''); const session=await sessions.resolve({company_id:request.company_id,session_id:request.input?.session_id});
      if(!session||session.company_id!==request.company_id) throw new ExecutionError('BROWSER_SESSION_SCOPE','Browser session is not owned by this company');
      if(!BROWSER_SESSION_SCOPES.includes(session.scope)) throw new ExecutionError('BROWSER_SESSION_SCOPE','Invalid browser session scope');
      const target=request.input?.url?new URL(request.input.url):null;
      if(target&&blockedDomains.some(d=>domainMatches(target.hostname,d))) throw new ExecutionError('DOMAIN_BLOCKED','Browser target is blocked');
      if(target&&allowedDomains.length&&!allowedDomains.some(d=>domainMatches(target.hostname,d))) throw new ExecutionError('DOMAIN_NOT_ALLOWED','Browser target is outside the allowlist');
      if(action==='evaluate'&&request.risk?.level!=='explicit-dangerous') throw new ExecutionError('EVALUATE_RESTRICTED','Arbitrary browser evaluation requires explicit dangerous-operation risk clearance');
      const result=await executor({action,session,input:request.input??{},signal:request.signal,externalContentTrust:'untrusted_external'});
      if(result?.requires_mfa) return {state:EXECUTION_STATES.WAITING_MFA,external_ref:result.external_ref,result:markBrowserObservationUntrusted(result.observation??null)};
      if(result?.requires_login) return {state:EXECUTION_STATES.WAITING_USER_AUTH,external_ref:result.external_ref,result:markBrowserObservationUntrusted(result.observation??null)};
      if(result?.requires_approval) return {state:EXECUTION_STATES.WAITING_APPROVAL,external_ref:result.external_ref,result:markBrowserObservationUntrusted(result.observation??null)};
      return {external_ref:result?.external_ref??null,result:{...result,observation:markBrowserObservationUntrusted(result?.observation??null)}};
    },
    async verify(raw,request){ const session=await sessions.resolve({company_id:request.company_id,session_id:request.input?.session_id}); return verifier({raw,request,session,externalContentTrust:'untrusted_external'}); }
  };
}
function domainMatches(host,rule){return host===rule||host.endsWith(`.${rule}`);}
