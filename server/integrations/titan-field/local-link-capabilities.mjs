/** Local Desk capability manifest: never confuses a shadow receipt with a live send. */
import {createLinkCapabilities} from './local-link-wire.mjs';
export function describeDeskLocalCapabilities(env=process.env){
  return createLinkCapabilities('titan-desk',{
    receive_communication:env.TITAN_FIELD_BRIDGE_MODE==='shadow'?'shadow':'not_configured',
    outbound_field_proposals:env.TITAN_DESK_REPLY_SHADOW_MODE==='1'?'proposal_only':'not_configured'
  });
}
