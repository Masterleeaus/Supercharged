/** Versioned read-only same-host capability handshake shared byte-for-byte by Field and Desk. */
import { createHmac, timingSafeEqual } from 'node:crypto';
export const LOCAL_LINK_SCHEMA='titan.zero.local-service-link.v1';
export const FIELD_CAPABILITY_PATH='/api/v1/titan/desk-bridge/capabilities';
export const DESK_CAPABILITY_PATH='/api/titan-bridge/v1/capabilities';
const SKEW_MS=180_000;
const SIGNATURE=/^sha256=([a-f0-9]{64})$/;
export class LocalLinkError extends Error {
  constructor(code,status=503){super(code);this.code=code;this.status=status;}
}
function requireSecret(secret){
  if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32||secret.trim()!==secret)
    throw new LocalLinkError('local_link_not_configured');
  return secret;
}
function requirePath(path){
  if(path!==FIELD_CAPABILITY_PATH&&path!==DESK_CAPABILITY_PATH)
    throw new LocalLinkError('local_link_invalid_path',400);
  return path;
}
function requireTime(value,now){
  if(typeof value!=='string'||!/^[0-9]{10,13}$/.test(value))
    throw new LocalLinkError('local_link_invalid_timestamp',401);
  const n=Number(value);const ms=value.length===10?n*1000:n;
  if(!Number.isSafeInteger(ms)||!Number.isFinite(now)||Math.abs(now-ms)>SKEW_MS)
    throw new LocalLinkError('local_link_stale_timestamp',401);
  return value;
}
function digest(secret,message){return createHmac('sha256',secret).update(message).digest('hex');}
function equalSignature(value,expected){
  const m=typeof value==='string'?SIGNATURE.exec(value):null;
  if(!m) return false;
  return timingSafeEqual(Buffer.from(m[1],'hex'),Buffer.from(expected,'hex'));
}
export function signLocalLinkRequest({secret,path,timestamp}){
  requireSecret(secret);requirePath(path);requireTime(String(timestamp),Number(timestamp)*1000);
  return 'sha256='+digest(secret,`${LOCAL_LINK_SCHEMA}\nGET\n${path}\n${timestamp}`);
}
export function verifyLocalLinkRequest({secret,path,timestamp,signature,now=Date.now()}){
  requireSecret(secret);requirePath(path);requireTime(timestamp,now);
  const expected=digest(secret,`${LOCAL_LINK_SCHEMA}\nGET\n${path}\n${timestamp}`);
  if(!equalSignature(signature,expected))throw new LocalLinkError('local_link_signature_invalid',401);
  return true;
}
export function signLocalLinkResponse({secret,path,timestamp,body}){
  requireSecret(secret);requirePath(path);
  if(typeof body!=='string'||Buffer.byteLength(body)>4096)throw new LocalLinkError('local_link_invalid_response');
  return 'sha256='+digest(secret,`${LOCAL_LINK_SCHEMA}\nRESPONSE\n${path}\n${timestamp}\n${body}`);
}
export function verifyLocalLinkResponse({secret,path,timestamp,body,signature}){
  const expected=signLocalLinkResponse({secret,path,timestamp,body});
  if(!equalSignature(signature,expected.slice('sha256='.length)))throw new LocalLinkError('local_link_receipt_invalid');
  let value;try{value=JSON.parse(body);}catch{throw new LocalLinkError('local_link_receipt_invalid');}
  if(!value||typeof value!=='object'||value.schema!==LOCAL_LINK_SCHEMA
      ||!['titan-field','titan-desk'].includes(value.service)
      ||value.execution!=='disabled'
      ||!value.capabilities||typeof value.capabilities!=='object'
      ||Object.values(value.capabilities).some(v=>!['shadow','proposal_only','not_configured'].includes(v)))
    throw new LocalLinkError('local_link_receipt_invalid');
  return value;
}
export function createLinkCapabilities(service, capabilities){
  if(!['titan-field','titan-desk'].includes(service))throw new LocalLinkError('local_link_invalid_service');
  if(!capabilities||typeof capabilities!=='object'||Array.isArray(capabilities))throw new LocalLinkError('local_link_invalid_capabilities');
  if(Object.values(capabilities).some(v=>!['shadow','proposal_only','not_configured'].includes(v)))
    throw new LocalLinkError('local_link_invalid_capabilities');
  return Object.freeze({schema:LOCAL_LINK_SCHEMA,service,execution:'disabled',capabilities:Object.freeze({...capabilities})});
}
