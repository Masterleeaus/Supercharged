/** Only loopback HTTP for colocated Field and Desk; never use arbitrary tenant URLs. */
import {LocalLinkError,FIELD_CAPABILITY_PATH,DESK_CAPABILITY_PATH} from './local-link-wire.mjs';
const PEERS=Object.freeze({
  'titan-field':{defaultOrigin:'http://127.0.0.1:3000',path:FIELD_CAPABILITY_PATH},
  'titan-desk':{defaultOrigin:'http://127.0.0.1:3001',path:DESK_CAPABILITY_PATH},
});
export function localPeerUrl(peer,{origin}={}){
  if(!Object.hasOwn(PEERS,peer))throw new LocalLinkError('local_link_unknown_peer');
  const expected=PEERS[peer];
  let url;
  try{url=new URL(origin??expected.defaultOrigin);}catch{throw new LocalLinkError('local_link_origin_invalid');}
  // Strictly local: no production hostname, userinfo, path injection, query or redirects.
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)
      ||url.username||url.password||url.pathname!=='/'||url.search||url.hash
      ||!url.port)throw new LocalLinkError('local_link_origin_invalid');
  return new URL(expected.path,url.origin);
}

/** Exact same-server target for the two existing signed shadow transports. */
export function localBridgeUrl(lane,{origin}={}){
  if(lane==='field_to_desk_intent') {
    const base=localPeerUrl('titan-desk',{origin});
    return new URL('/api/titan-bridge/v1/communication-intents',base.origin);
  }
  if(lane==='desk_to_field_proposal') {
    const base=localPeerUrl('titan-field',{origin});
    return new URL('/api/v1/titan/desk-bridge/reply-proposals',base.origin);
  }
  throw new LocalLinkError('local_link_unknown_lane');
}
