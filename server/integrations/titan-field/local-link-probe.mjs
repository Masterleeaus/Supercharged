/** Read-only signed peer probe. Requires no cross-database access. */
import {LocalLinkError,signLocalLinkRequest,verifyLocalLinkResponse} from './local-link-wire.mjs';
import {localPeerUrl} from './local-link-topology.mjs';
export async function probeLocalPeer(peer,{
  origin,secret=process.env.TITAN_LOCAL_LINK_SECRET,
  fetchImpl=globalThis.fetch,now=Date.now(),timeoutMs=1800
}={}){
  if(!Number.isFinite(now)||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>5000)
    throw new LocalLinkError('local_link_probe_options_invalid');
  const url=localPeerUrl(peer,{origin});
  const timestamp=String(Math.floor(now/1000));
  const signature=signLocalLinkRequest({secret,path:url.pathname,timestamp});
  let response;
  try{response=await fetchImpl(url.href,{method:'GET',redirect:'error',cache:'no-store',
    headers:{'x-titan-local-timestamp':timestamp,'x-titan-local-signature':signature},
    signal:AbortSignal.timeout(timeoutMs)});
  }catch{throw new LocalLinkError('local_link_peer_unreachable');}
  if(!response?.ok)throw new LocalLinkError('local_link_peer_unavailable');
  let body;try{body=await response.text();}catch{throw new LocalLinkError('local_link_peer_unreadable');}
  if(Buffer.byteLength(body,'utf8')>4096)throw new LocalLinkError('local_link_peer_unreadable');
  const receipt=verifyLocalLinkResponse({secret,path:url.pathname,timestamp,body,
    signature:response.headers.get('x-titan-local-receipt-signature')});
  if(receipt.service!==peer)throw new LocalLinkError('local_link_wrong_peer');
  return Object.freeze({reachable:true,service:peer,capabilities:receipt.capabilities,execution_enabled:false});
}
