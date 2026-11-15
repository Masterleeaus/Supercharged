/** Product-side signer for Central account-link assertions (EdDSA, typ titan-link+jwt).
 * Contract source: Central docs/LINKING.md as quoted in issue #192. Live Central was NOT verified.
 * The private key is read only from environment variables and never logged or exported.
 * Only the public JWK is ever shared with Central for registration.
 */
import {createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject} from 'node:crypto';

export const LINK_ASSERTION_TYP='titan-link+jwt';
export const LINK_ASSERTION_ISSUER='supercharged';
export const LINK_ASSERTION_AUDIENCE='titan-central';
export const LINK_ASSERTION_MAX_TTL_SECONDS=300;
export const LINK_ASSERTION_DEFAULT_TTL_SECONDS=120;
export const LINK_ASSERTION_SKEW_SECONDS=30;
export const LINK_KEY_ENV='CENTRAL_LINK_SIGNING_KEY';
export const LINK_KID_ENV='CENTRAL_LINK_SIGNING_KID';

export const LINK_FORBIDDEN_CLAIMS=Object.freeze(['email','email_verified','name','given_name','family_name',
 'display_name','displayName','preferred_username','username','nickname','phone_number']);
const INPUT_CLAIMS=['sub','org','lu','la'];
const ALLOWED_CLAIMS=['iss','aud','sub','org','lu','la','nonce','iat','exp'];
const HEADER_KEYS=['alg','typ','kid'];
const ID_RE=/^[^\s\x00-\x1f\x7f]{1,256}$/u;
const NONCE_RE=/^[A-Za-z0-9_-]{22,128}$/;
const KID_RE=/^[A-Za-z0-9._:-]{1,128}$/;

export type LinkRejectCode=
 'config_missing'|'config_invalid'|'forbidden_claim'|'unknown_claim'|'invalid_input'|
 'malformed'|'header_mismatch'|'bad_signature'|'wrong_issuer'|'wrong_audience'|'bad_nonce'|
 'replayed_nonce'|'ttl_exceeded'|'expired'|'issued_in_future';

export class LinkAssertionError extends Error{
 readonly code:LinkRejectCode;
 constructor(code:LinkRejectCode,message?:string){super(message??code);this.name='LinkAssertionError';this.code=code}
}

export interface LinkAssertionInput{sub:string;org:string;lu:string;la:string}
export interface LinkSigningConfig{privateKey:KeyObject;kid:string}
export interface SignedLinkAssertion{token:string;nonce:string;iat:number;exp:number}

const b64u=(buf:Buffer|string)=>Buffer.from(buf).toString('base64url');
const fromB64u=(s:string)=>Buffer.from(s,'base64url');

/** Reads the signing key and key id from environment variables only.
 * The key must be PKCS8 PEM for an Ed25519 key. Literal "\n" sequences are accepted.
 */
export function readLinkSigningConfig(env:NodeJS.ProcessEnv=process.env):LinkSigningConfig{
 const raw=env[LINK_KEY_ENV];const kid=env[LINK_KID_ENV];
 if(!raw||!kid)throw new LinkAssertionError('config_missing','link signing key or key id not set');
 if(!KID_RE.test(kid))throw new LinkAssertionError('config_invalid','link key id has an invalid format');
 try{
  const privateKey=createPrivateKey(raw.includes('\\n')?raw.replace(/\\n/g,'\n'):raw);
  if(privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519')
   throw new Error('not ed25519');
  return {privateKey,kid};
 }catch{throw new LinkAssertionError('config_invalid','link signing key is not an Ed25519 PKCS8 PEM')}
}

/** Public JWK for Central registration. Contains no private member. */
export function linkPublicJwk(config:LinkSigningConfig):{kty:'OKP';crv:'Ed25519';alg:'EdDSA';use:'sig';kid:string;x:string}{
 const pub=createPublicKey(config.privateKey).export({format:'jwk'}) as {x?:string};
 if(typeof pub.x!=='string')throw new LinkAssertionError('config_invalid','public key export failed');
 return {kty:'OKP',crv:'Ed25519',alg:'EdDSA',use:'sig',kid:config.kid,x:pub.x};
}

function assertInput(input:unknown):asserts input is LinkAssertionInput{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new LinkAssertionError('invalid_input');
 const keys=Object.keys(input);
 for(const k of keys){
  if(LINK_FORBIDDEN_CLAIMS.includes(k))throw new LinkAssertionError('forbidden_claim',`claim ${k} is not allowed`);
  if(!INPUT_CLAIMS.includes(k))throw new LinkAssertionError('unknown_claim',`claim ${k} is not allowed`);
 }
 const x=input as Record<string,unknown>;
 for(const k of INPUT_CLAIMS){
  if(typeof x[k]!=='string'||!ID_RE.test(x[k] as string))throw new LinkAssertionError('invalid_input',`claim ${k} is invalid`);
 }
}

/** Issues a compact EdDSA JWS. The header has exactly alg, typ and kid. */
export function createLinkAssertionSigner({config,now=()=>Date.now(),ttlSeconds=LINK_ASSERTION_DEFAULT_TTL_SECONDS,
 nonceBytes=24}:{config:LinkSigningConfig;now?:()=>number;ttlSeconds?:number;nonceBytes?:number}){
 if(!config||!config.privateKey||typeof config.kid!=='string')throw new TypeError('link signing config required');
 if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>LINK_ASSERTION_MAX_TTL_SECONDS)
  throw new RangeError('ttlSeconds must be 1 to 300');
 if(!Number.isSafeInteger(nonceBytes)||nonceBytes<16||nonceBytes>96)throw new RangeError('nonceBytes out of range');
 return function signLinkAssertion(input:LinkAssertionInput):SignedLinkAssertion{
  assertInput(input);
  const iat=Math.floor(now()/1000);
  const exp=iat+ttlSeconds;
  const nonce=randomBytes(nonceBytes).toString('base64url');
  const header={alg:'EdDSA',typ:LINK_ASSERTION_TYP,kid:config.kid};
  const claims={iss:LINK_ASSERTION_ISSUER,aud:LINK_ASSERTION_AUDIENCE,sub:input.sub,org:input.org,
   lu:input.lu,la:input.la,nonce,iat,exp};
  const signingInput=`${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig=sign(null,Buffer.from(signingInput,'utf8'),config.privateKey);
  return {token:`${signingInput}.${b64u(sig)}`,nonce,iat,exp};
 };
}

/** Single-use nonce ledger. In-memory only: a durable store is required before multi-instance use. */
export function createNonceLedger({now=()=>Date.now()}:{now?:()=>number}={}){
 const seen=new Map<string,number>();
 return {
  consume(nonce:string,expiresAtMs:number):boolean{
   const t=now();
   for(const [k,v] of seen){if(v<=t)seen.delete(k)}
   if(seen.has(nonce))return false;
   seen.set(nonce,expiresAtMs);
   return true;
  },
  size:()=>seen.size,
 };
}

/** Verifies a token as Central would. Used by tests and self-checks; no production caller yet. */
export function verifyLinkAssertion(token:unknown,{publicKey,kid,now=()=>Date.now(),ledger}:
 {publicKey:KeyObject;kid?:string;now?:()=>number;ledger?:ReturnType<typeof createNonceLedger>}):
 {header:Record<string,string>;claims:Record<string,unknown>}{
 if(typeof token!=='string'||token.length>8192)throw new LinkAssertionError('malformed');
 const parts=token.split('.');
 if(parts.length!==3||parts.some(p=>!/^[A-Za-z0-9_-]+$/.test(p)))throw new LinkAssertionError('malformed');
 let header:Record<string,unknown>,claims:Record<string,unknown>;
 try{
  header=JSON.parse(fromB64u(parts[0]).toString('utf8'));
  claims=JSON.parse(fromB64u(parts[1]).toString('utf8'));
 }catch{throw new LinkAssertionError('malformed')}
 if(!header||typeof header!=='object'||Array.isArray(header)||!claims||typeof claims!=='object'||Array.isArray(claims))
  throw new LinkAssertionError('malformed');
 const hk=Object.keys(header).sort().join(',');
 if(hk!==[...HEADER_KEYS].sort().join(',')||header.alg!=='EdDSA'||header.typ!==LINK_ASSERTION_TYP||
  typeof header.kid!=='string'||(kid!==undefined&&header.kid!==kid))
  throw new LinkAssertionError('header_mismatch');
 const ok=verify(null,Buffer.from(`${parts[0]}.${parts[1]}`,'utf8'),publicKey,fromB64u(parts[2]));
 if(!ok)throw new LinkAssertionError('bad_signature');
 const c=claims as Record<string,unknown>;
 for(const k of Object.keys(c)){
  if(LINK_FORBIDDEN_CLAIMS.includes(k))throw new LinkAssertionError('forbidden_claim');
  if(!ALLOWED_CLAIMS.includes(k))throw new LinkAssertionError('unknown_claim');
 }
 if(c.iss!==LINK_ASSERTION_ISSUER)throw new LinkAssertionError('wrong_issuer');
 if(c.aud!==LINK_ASSERTION_AUDIENCE)throw new LinkAssertionError('wrong_audience');
 for(const k of ['sub','org','lu','la'])if(typeof c[k]!=='string'||!ID_RE.test(c[k] as string))throw new LinkAssertionError('malformed');
 if(typeof c.nonce!=='string'||!NONCE_RE.test(c.nonce))throw new LinkAssertionError('bad_nonce');
 const {iat,exp}=c as {iat:unknown;exp:unknown};
 if(!Number.isSafeInteger(iat)||!Number.isSafeInteger(exp)||(exp as number)<=(iat as number)||
  (exp as number)-(iat as number)>LINK_ASSERTION_MAX_TTL_SECONDS)throw new LinkAssertionError('ttl_exceeded');
 const nowS=Math.floor(now()/1000);
 if((iat as number)>nowS+LINK_ASSERTION_SKEW_SECONDS)throw new LinkAssertionError('issued_in_future');
 if(nowS>=(exp as number))throw new LinkAssertionError('expired');
 if(ledger&&!ledger.consume(c.nonce,(exp as number)*1000))throw new LinkAssertionError('replayed_nonce');
 return {header:header as Record<string,string>,claims:c};
}
