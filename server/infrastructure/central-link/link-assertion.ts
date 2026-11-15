/** Signs the account-link assertion that Central verifies (docs/LINKING.md in Masterleeaus/Central).
 * Compact JWS, EdDSA (Ed25519). Header is exactly alg, typ and kid. Claims are the
 * documented set only. Email, name and display fields are refused before signing.
 */
import {randomBytes, sign} from 'node:crypto';
import type {LinkSigningConfig} from './config.ts';

export const LINK_ASSERTION_ALG='EdDSA';
export const LINK_ASSERTION_TYP='titan-link+jwt';
export const LINK_ASSERTION_MAX_TTL_SECONDS=300;
export const LINK_ASSERTION_DEFAULT_TTL_SECONDS=120;

/** Claims Central refuses. A link is never proven or selected by these values. */
export const FORBIDDEN_LINK_CLAIMS=[
 'email','email_verified','name','given_name','family_name','display_name','displayName',
 'preferred_username','username','nickname','phone_number',
] as const;

const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ALLOWED_INPUT=new Set(['sub','org','lu','la','ttlSeconds']);

export type LinkAssertionErrorCode=
 'forbidden_claim'|'unexpected_field'|'invalid_identifier'|'invalid_lifetime'|'nonce_reused';

export class LinkAssertionError extends Error {
 readonly code:LinkAssertionErrorCode;
 constructor(code:LinkAssertionErrorCode,message:string){super(message);this.name='LinkAssertionError';this.code=code}
}

/** Central identity subject, Logto organisation id, and the opaque local IDs. */
export type LinkAssertionInput={sub:string;org:string;lu:string;la:string;ttlSeconds?:number};

/** Remembers nonces issued by this process until they expire. Reuse is refused.
 * This store is in memory only. Central also enforces single use, so a restart
 * cannot create a replay, but a durable store is still needed before production.
 */
export class IssuedNonceLedger {
 private readonly expiries=new Map<string,number>();
 record(nonce:string,expiresAtSeconds:number,nowSeconds:number):void{
  for(const [seen,expiry] of this.expiries){if(expiry<=nowSeconds)this.expiries.delete(seen)}
  if(this.expiries.has(nonce))throw new LinkAssertionError('nonce_reused','nonce already issued');
  this.expiries.set(nonce,expiresAtSeconds);
 }
}

function checkIdentifier(name:string,value:unknown):string{
 if(typeof value!=='string'||!IDENTIFIER.test(value))
  throw new LinkAssertionError('invalid_identifier',`${name} is not an opaque identifier`);
 return value;
}

function checkLifetime(value:unknown):number{
 if(value===undefined)return LINK_ASSERTION_DEFAULT_TTL_SECONDS;
 if(!Number.isSafeInteger(value)||(value as number)<1||(value as number)>LINK_ASSERTION_MAX_TTL_SECONDS)
  throw new LinkAssertionError('invalid_lifetime',`ttlSeconds must be an integer from 1 to ${LINK_ASSERTION_MAX_TTL_SECONDS}`);
 return value as number;
}

/** Refuses forbidden claims and any unknown field, before anything is signed. */
export function assertLinkInputShape(input:unknown):asserts input is LinkAssertionInput{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new LinkAssertionError('unexpected_field','assertion input must be an object');
 for(const key of Object.keys(input)){
  if((FORBIDDEN_LINK_CLAIMS as readonly string[]).includes(key))
   throw new LinkAssertionError('forbidden_claim',`claim ${key} is not permitted in a link assertion`);
  if(!ALLOWED_INPUT.has(key))throw new LinkAssertionError('unexpected_field',`field ${key} is not permitted`);
 }
}

export type SignedLinkAssertion={token:string;nonce:string;iat:number;exp:number};

/** Signs one assertion. Each call issues a fresh 256-bit nonce, recorded in the ledger. */
export function signLinkAssertion(
 config:LinkSigningConfig,
 input:unknown,
 options:{ledger:IssuedNonceLedger;nowMs?:number}
):SignedLinkAssertion{
 assertLinkInputShape(input);
 const sub=checkIdentifier('sub',input.sub);
 const org=checkIdentifier('org',input.org);
 const lu=checkIdentifier('lu',input.lu);
 const la=checkIdentifier('la',input.la);
 const ttl=checkLifetime(input.ttlSeconds);

 const nowSeconds=Math.floor((options.nowMs??Date.now())/1000);
 const iat=nowSeconds;
 const exp=iat+ttl;
 const nonce=randomBytes(32).toString('base64url');
 options.ledger.record(nonce,exp,nowSeconds);

 const header=JSON.stringify({alg:LINK_ASSERTION_ALG,typ:LINK_ASSERTION_TYP,kid:config.kid});
 const payload=JSON.stringify({iss:config.issuer,aud:config.audience,sub,org,lu,la,nonce,iat,exp});
 const signingInput=`${Buffer.from(header,'utf8').toString('base64url')}.${Buffer.from(payload,'utf8').toString('base64url')}`;
 const signature=sign(null,Buffer.from(signingInput,'ascii'),config.privateKey).toString('base64url');
 return {token:`${signingInput}.${signature}`,nonce,iat,exp};
}
