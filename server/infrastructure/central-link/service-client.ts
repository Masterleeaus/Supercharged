/** Supercharged's own service token for calls to Central (client-credentials grant).
 * The tenant is never sent by Supercharged. Central takes it from the verified token,
 * and a request carrying organisation, tenant or cohort fields is refused here first.
 * Tokens are cached in memory and refreshed before expiry. Nothing is logged.
 */
import type {CentralServiceConfig} from './config.ts';

export type CentralServiceErrorCode=
 'token_request_failed'|'token_invalid'|'wrong_audience'|'tenant_parameter_refused'|'invalid_path'|'central_request_failed';

export class CentralServiceError extends Error {
 readonly code:CentralServiceErrorCode;
 constructor(code:CentralServiceErrorCode,message:string){super(message);this.name='CentralServiceError';this.code=code}
}

export type FetchLike=(url:string,init:{
 method:string;headers:Record<string,string>;body?:string;redirect:'error';signal:AbortSignal;
}) => Promise<{ok:boolean;status:number;json():Promise<unknown>}>;

const TENANT_KEYS=new Set(['organisationid','organizationid','tenant','tenantid','cohort','cohorts','titanorganisationid']);
const REFRESH_SKEW_MS=60_000;
const REQUEST_TIMEOUT_MS=10_000;

/** Refuses organisation, tenant or cohort fields anywhere in a query or body, at any depth. */
export function assertNoTenantFields(value:unknown,where:'query'|'body'):void{
 if(value===null||typeof value!=='object')return;
 if(Array.isArray(value)){for(const item of value)assertNoTenantFields(item,where);return}
 for(const [key,inner] of Object.entries(value)){
  if(TENANT_KEYS.has(key.toLowerCase().replace(/[_-]/g,'')))
   throw new CentralServiceError('tenant_parameter_refused',`${where} must not carry a tenant field`);
  assertNoTenantFields(inner,where);
 }
}

function decodeJwtPayload(token:string):Record<string,unknown>|null{
 const parts=token.split('.');
 if(parts.length!==3)return null;
 try{
  const parsed=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')) as unknown;
  return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:null;
 }catch{return null}
}

/** Fails closed. A token that is not a JWT with a matching aud is refused, and never cached. */
export function assertTokenAudience(token:string,audience:string):void{
 const payload=decodeJwtPayload(token);
 if(!payload)throw new CentralServiceError('token_invalid','Central returned a token that cannot be checked');
 const aud=payload.aud;
 const matches=typeof aud==='string'?aud===audience:Array.isArray(aud)&&aud.includes(audience);
 if(!matches)throw new CentralServiceError('wrong_audience','Central returned a token for another audience');
}

export function createCentralServiceClient({
 config,fetchImpl,nowMs=()=>Date.now(),
}:{
 config:CentralServiceConfig;
 fetchImpl:FetchLike;
 nowMs?:()=>number;
}){
 if(typeof fetchImpl!=='function')throw new TypeError('fetch implementation required');
 let cached:{token:string;expiresAtMs:number}|null=null;
 let inflight:Promise<string>|null=null;

 async function requestToken():Promise<string>{
  const basic=Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64');
  let response:Awaited<ReturnType<FetchLike>>;
  try{
   response=await fetchImpl(config.tokenUrl,{
    method:'POST',
    headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
    body:new URLSearchParams({grant_type:'client_credentials',audience:config.audience}).toString(),
    redirect:'error',
    signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS),
   });
  }catch{throw new CentralServiceError('token_request_failed','Central token request failed')}
  if(!response.ok)throw new CentralServiceError('token_request_failed','Central token request was refused');
  let body:unknown;
  try{body=await response.json()}catch{throw new CentralServiceError('token_request_failed','Central token response was not JSON')}
  const b=(body&&typeof body==='object')?body as Record<string,unknown>:{};
  const token=b.access_token;
  const lifetime=b.expires_in;
  if(typeof token!=='string'||token.length<1||token.length>8192||/\s/.test(token))
   throw new CentralServiceError('token_invalid','Central token response has no usable access token');
  if(typeof b.token_type!=='string'||b.token_type.toLowerCase()!=='bearer')
   throw new CentralServiceError('token_invalid','Central token type is not bearer');
  if(!Number.isSafeInteger(lifetime)||(lifetime as number)<1||(lifetime as number)>86_400)
   throw new CentralServiceError('token_invalid','Central token lifetime is not usable');
  assertTokenAudience(token,config.audience);
  cached={token,expiresAtMs:nowMs()+(lifetime as number)*1000};
  return token;
 }

 async function currentToken():Promise<string>{
  if(cached&&nowMs()<cached.expiresAtMs-REFRESH_SKEW_MS)return cached.token;
  if(!inflight)inflight=requestToken().finally(()=>{inflight=null});
  return inflight;
 }

 /** Calls Central with the service token. Path is absolute and has no query string; use `query`. */
 async function request(input:{
  method:'GET'|'POST';path:string;query?:Record<string,string>;body?:unknown;
 }):Promise<{status:number;body:unknown}>{
  if(!input.path.startsWith('/')||input.path.startsWith('//')||input.path.includes('?')||input.path.includes('#'))
   throw new CentralServiceError('invalid_path','request path must be absolute and carry no query string');
  assertNoTenantFields(input.query,'query');
  assertNoTenantFields(input.body,'body');
  const url=new URL(input.path,config.origin);
  for(const [k,v] of Object.entries(input.query??{}))url.searchParams.set(k,v);
  const token=await currentToken();
  const hasBody=input.body!==undefined;
  let response:Awaited<ReturnType<FetchLike>>;
  try{
   response=await fetchImpl(url.href,{
    method:input.method,
    headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(hasBody?{'Content-Type':'application/json'}:{})},
    body:hasBody?JSON.stringify(input.body):undefined,
    redirect:'error',
    signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS),
   });
  }catch{throw new CentralServiceError('central_request_failed','Central request failed')}
  if(response.status===401)cached=null;
  let body:unknown=null;
  try{body=await response.json()}catch{body=null}
  return {status:response.status,body};
 }

 return {request};
}
