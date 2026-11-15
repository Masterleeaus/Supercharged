/** Central link and service configuration, read only from the environment.
 * A missing or malformed value fails with its variable name and rule. No value
 * is ever echoed into an error, so secrets cannot leak through a failed start.
 */
import {createPrivateKey, createPublicKey, type KeyObject} from 'node:crypto';

export class CentralConfigError extends Error {
 readonly code='central_config_invalid';
 constructor(message:string){super(message);this.name='CentralConfigError'}
}

export type EnvMap=Readonly<Record<string,string|undefined>>;

function required(env:EnvMap,name:string):string{
 const value=env[name];
 if(value===undefined||value.trim()==='')throw new CentralConfigError(`Missing required environment variable ${name}`);
 return value.trim();
}

function httpsOrigin(env:EnvMap,name:string):string{
 const raw=required(env,name);
 let url:URL;
 try{url=new URL(raw)}catch{throw new CentralConfigError(`${name} must be an absolute https URL`)}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||(url.pathname!=='/'&&url.pathname!==''))
  throw new CentralConfigError(`${name} must be an https origin with no credentials, path, query or fragment`);
 return url.origin;
}

function readPrivateKey(pem:string):KeyObject{
 let key:KeyObject;
 try{key=createPrivateKey(pem)}catch{throw new CentralConfigError('CENTRAL_LINK_PRIVATE_KEY is not a readable PEM private key')}
 if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')
  throw new CentralConfigError('CENTRAL_LINK_PRIVATE_KEY must be an Ed25519 private key');
 return key;
}

export type LinkSigningConfig={issuer:string;audience:string;kid:string;privateKey:KeyObject};

/** Reads the product-side signing configuration.
 * CENTRAL_LINK_ISSUER is the product id (for example `supercharged`).
 * CENTRAL_LINK_AUDIENCE is Central's audience (`titan-central`).
 * CENTRAL_LINK_KEY_ID is the kid Central has registered for the public key.
 * CENTRAL_LINK_PRIVATE_KEY is the PKCS#8 PEM of the Ed25519 key, from the secret store.
 */
export function readLinkSigningConfig(env:EnvMap=process.env):LinkSigningConfig{
 const issuer=required(env,'CENTRAL_LINK_ISSUER');
 if(!/^[a-z][a-z0-9_-]{0,63}$/.test(issuer))throw new CentralConfigError('CENTRAL_LINK_ISSUER must be a lowercase product id');
 const audience=required(env,'CENTRAL_LINK_AUDIENCE');
 if(!/^[A-Za-z0-9._:-]{1,128}$/.test(audience))throw new CentralConfigError('CENTRAL_LINK_AUDIENCE has an invalid format');
 const kid=required(env,'CENTRAL_LINK_KEY_ID');
 if(!/^[A-Za-z0-9._-]{1,64}$/.test(kid))throw new CentralConfigError('CENTRAL_LINK_KEY_ID has an invalid format');
 const pem=required(env,'CENTRAL_LINK_PRIVATE_KEY').replace(/\\n/g,'\n');
 return {issuer,audience,kid,privateKey:readPrivateKey(pem)};
}

/** Public JWK for registration with the Central operator. Public members only. */
export function publicJwkFor(privateKey:KeyObject):{kty:'OKP';crv:'Ed25519';x:string}{
 const jwk=createPublicKey(privateKey).export({format:'jwk'}) as {kty?:string;crv?:string;x?:string};
 if(jwk.kty!=='OKP'||jwk.crv!=='Ed25519'||typeof jwk.x!=='string')throw new CentralConfigError('signing key did not export an Ed25519 public key');
 return {kty:'OKP',crv:'Ed25519',x:jwk.x};
}

export type CentralServiceConfig={origin:string;tokenUrl:string;clientId:string;clientSecret:string;audience:string};

/** Reads the client-credentials configuration for calls from Supercharged to Central.
 * CENTRAL_ORIGIN is the https origin of Central's API.
 * CENTRAL_TOKEN_URL is the full https token endpoint on that origin.
 * CENTRAL_SERVICE_CLIENT_ID and CENTRAL_SERVICE_CLIENT_SECRET come from the secret store.
 * CENTRAL_SERVICE_AUDIENCE is the product audience (`urn:titan-central:product:supercharged`).
 */
export function readCentralServiceConfig(env:EnvMap=process.env):CentralServiceConfig{
 const origin=httpsOrigin(env,'CENTRAL_ORIGIN');
 const tokenUrl=new URL(required(env,'CENTRAL_TOKEN_URL'));
 if(tokenUrl.protocol!=='https:'||tokenUrl.origin!==origin||tokenUrl.username||tokenUrl.password||tokenUrl.hash)
  throw new CentralConfigError('CENTRAL_TOKEN_URL must be an https URL on the CENTRAL_ORIGIN origin with no credentials or fragment');
 const audience=required(env,'CENTRAL_SERVICE_AUDIENCE');
 if(!/^urn:titan-central:product:[a-z][a-z0-9_-]{0,63}$/.test(audience))
  throw new CentralConfigError('CENTRAL_SERVICE_AUDIENCE must be a titan-central product audience URN');
 return {
  origin,
  tokenUrl:tokenUrl.href,
  clientId:required(env,'CENTRAL_SERVICE_CLIENT_ID'),
  clientSecret:required(env,'CENTRAL_SERVICE_CLIENT_SECRET'),
  audience,
 };
}
