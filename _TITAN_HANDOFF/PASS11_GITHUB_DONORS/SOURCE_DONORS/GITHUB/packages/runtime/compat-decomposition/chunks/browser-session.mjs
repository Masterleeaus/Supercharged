import {createBrowserSessionRegistry} from '../../browser/session-registry.mjs';

export const COMPAT_BROWSER_SESSION_CHUNK_SCHEMA='titan.zero.compat-browser-session-chunk.v1';

export function createCompatBrowserSessionChunk({company_id}={}){
  const cid=String(company_id||'').trim();
  if(!cid) throw new Error('company_id_required');
  const registry=createBrowserSessionRegistry({company_id:cid});
  return Object.freeze({
    schema:COMPAT_BROWSER_SESSION_CHUNK_SCHEMA,
    company_id:cid,
    upsert:raw=>registry.upsert(raw),
    get:id=>registry.get(id),
    list:()=>registry.list(),
    remove:id=>registry.remove(id),
    authority_neutral:true,
    identity_confers_authority:false,
    loading_confers_authority:false
  });
}
