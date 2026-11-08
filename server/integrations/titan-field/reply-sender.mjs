/** Desk -> Field HTTP transport. Only a simulated action-proposal receipt can pass. */
import {REPLY_PATH, parseReplyProposal, signReply, parseProposalReceipt, assertReplySecret} from './reply-protocol.mjs';
import {ReplyCaptureUnavailable} from './reply-capture.mjs';
import {localBridgeUrl} from './local-link-topology.mjs';

export async function submitFieldReplyProposal(proposal, {
  endpoint = process.env.TITAN_FIELD_REPLY_BRIDGE_URL || (process.env.TITAN_LOCAL_LINK_ENABLED === '1'
    ? localBridgeUrl('desk_to_field_proposal',{origin:process.env.TITAN_LOCAL_FIELD_ORIGIN||undefined}).href : undefined),
  secret = process.env.TITAN_FIELD_REPLY_BRIDGE_SECRET,
  fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 3000
} = {}) {
  if (typeof endpoint !== 'string' || !endpoint) throw new ReplyCaptureUnavailable('field_reply_url_missing');
  let url;
  try {url = new URL(endpoint);} catch {throw new ReplyCaptureUnavailable('field_reply_url_invalid');}
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash || url.pathname !== REPLY_PATH)
    throw new ReplyCaptureUnavailable('field_reply_url_invalid');
  assertReplySecret(secret);
  const body = Buffer.from(JSON.stringify(proposal));
  parseReplyProposal(body,{now});
  const timestamp = String(Math.floor(now/1000));
  const signature = signReply({body,secret,timestamp:Number(timestamp)});
  let response;
  try {
    response = await fetchImpl(url.href, {method:'POST',redirect:'error',cache:'no-store',
      headers:{'content-type':'application/json','x-titan-reply-timestamp':timestamp,
        'x-titan-reply-signature':signature}, body:body.toString('utf8'),
      signal:AbortSignal.timeout(Math.min(10000,Math.max(100,timeoutMs)))});
  } catch {throw new ReplyCaptureUnavailable('field_reply_transport_unavailable');}
  if (!response.ok) throw new ReplyCaptureUnavailable(`field_reply_http_${response.status}`);
  let receipt;
  try {receipt = await response.json();}
  catch {throw new ReplyCaptureUnavailable('field_reply_receipt_unreadable');}
  try {return parseProposalReceipt(receipt,proposal);}
  catch {throw new ReplyCaptureUnavailable('field_reply_receipt_invalid');}
}
