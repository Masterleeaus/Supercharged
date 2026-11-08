/**
 * Titan Desk -> Field: versioned, data-minimised, proposal-only wire protocol.
 * This file must be copied byte-for-byte to Field until a canonical shared
 * package is adopted. No provider messages, numbers, or free text on the wire.
 */
import {createHmac, timingSafeEqual} from 'node:crypto';

export const REPLY_SCHEMA = 'titan.desk-field.action-proposal.v1';
export const REPLY_RECEIPT_SCHEMA = 'titan.desk-field.proposal-receipt.v1';
export const REPLY_PATH = '/api/v1/titan/desk-bridge/reply-proposals';
export const REPLY_MAX_BYTES = 4096;
export const REPLY_SKEW_SECONDS = 300;
export const REPLY_ACTIONS = Object.freeze([
  'confirm_visit', 'reschedule_request', 'request_quote', 'request_callback',
  'invoice_question', 'opt_out_notice', 'general_enquiry'
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const ACTIONS = new Set(REPLY_ACTIONS);
const CHANNELS = new Set(['sms','email','voice']);
const RESOURCE_KINDS = new Set(['visit','job','estimate','invoice','booking_request','client']);
const POLICY = Object.freeze({
  confirm_visit: ['visit'], reschedule_request: ['visit','booking_request'],
  request_quote: ['client','job','booking_request'],
  request_callback: ['client','job','booking_request'],
  invoice_question: ['invoice'], opt_out_notice: ['client'],
  general_enquiry: ['client','job','booking_request']
});

export class ReplyProtocolError extends Error {
  constructor(code, status = 422) {super(code); this.code = code; this.httpStatus = status;}
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new ReplyProtocolError(`invalid_${name}`);
  return value;
}
function keys(value, allowed, label) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ReplyProtocolError(`unexpected_${label}_field`);
}
function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new ReplyProtocolError(`invalid_${name}`);
  return value;
}
function at(value, name, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new ReplyProtocolError(`invalid_${name}`);
  const parsed = Date.parse(value);
  if (parsed > now + 60000 || parsed < now - 24 * 3600000) throw new ReplyProtocolError(`stale_${name}`);
  return value;
}
export function parseReplyProposal(input, {now = Date.now()} = {}) {
  if (!Number.isFinite(now)) throw new ReplyProtocolError('invalid_clock');
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '');
  if (!bytes.length || bytes.length > REPLY_MAX_BYTES) throw new ReplyProtocolError('invalid_reply_size', 413);
  let data;
  try {data = JSON.parse(bytes.toString('utf8'));}
  catch {throw new ReplyProtocolError('invalid_reply_json', 400);}
  const proposal = object(data, 'proposal');
  keys(proposal, ['schema','company_id','event_id','correlation_id','desk_user_id','received_at','source','resource','action','evidence'], 'proposal');
  if (proposal.schema !== REPLY_SCHEMA) throw new ReplyProtocolError('unsupported_reply_schema');
  for (const name of ['company_id','event_id','correlation_id','desk_user_id']) id(proposal[name],name);
  at(proposal.received_at, 'received_at', now);
  const source = object(proposal.source, 'source');
  keys(source, ['channel','provider_event_reference','conversation_reference'], 'source');
  if (!CHANNELS.has(source.channel)) throw new ReplyProtocolError('invalid_source_channel');
  id(source.provider_event_reference,'provider_event_reference');
  id(source.conversation_reference,'conversation_reference');
  const resource = object(proposal.resource, 'resource');
  keys(resource, ['kind','reference','client_reference'], 'resource');
  if (!RESOURCE_KINDS.has(resource.kind)) throw new ReplyProtocolError('invalid_resource_kind');
  id(resource.reference,'resource_reference');
  id(resource.client_reference,'client_reference');
  const action = object(proposal.action, 'action');
  keys(action, ['kind','classifier_version'], 'action');
  if (!ACTIONS.has(action.kind)) throw new ReplyProtocolError('invalid_action_kind');
  if (!POLICY[action.kind].includes(resource.kind)) throw new ReplyProtocolError('action_resource_mismatch');
  id(action.classifier_version,'classifier_version');
  const evidence = object(proposal.evidence, 'evidence');
  keys(evidence, ['desk_record_reference','provider_verified'], 'evidence');
  id(evidence.desk_record_reference,'desk_record_reference');
  if (evidence.provider_verified !== true) throw new ReplyProtocolError('provider_not_verified');
  // No raw message, phone, email, display name, provider credentials or generated
  // customer-facing content is accepted, including at nested levels.
  return proposal;
}
export function assertReplySecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || secret.trim() !== secret)
    throw new ReplyProtocolError('reply_secret_unconfigured', 503);
  return secret;
}
export function signReply({body,secret,timestamp = Math.floor(Date.now()/1000)}) {
  assertReplySecret(secret);
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!raw.length || raw.length > REPLY_MAX_BYTES) throw new ReplyProtocolError('invalid_reply_size', 413);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new ReplyProtocolError('invalid_timestamp', 400);
  return createHmac('sha256',secret).update('desk-to-field-reply-v1.').update(String(timestamp)).update('.').update(raw).digest('hex');
}
export function verifyReply({body,secret,timestamp,signature,now = Date.now()}) {
  assertReplySecret(secret);
  if (typeof timestamp !== 'string' || !/^\d{10,12}$/.test(timestamp)
     || !Number.isFinite(Number(timestamp)) || Math.abs(now/1000 - Number(timestamp)) > REPLY_SKEW_SECONDS
     || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature))
    throw new ReplyProtocolError('reply_unauthorized', 401);
  const expected = signReply({body,secret,timestamp:Number(timestamp)});
  if (!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex')))
    throw new ReplyProtocolError('reply_unauthorized',401);
  return true;
}
export function parseProposalReceipt(value, proposal) {
  const receipt = object(value, 'receipt');
  keys(receipt,['schema','company_id','source_event_id','correlation_id','status','action_executed','occurred_at'],'receipt');
  if (receipt.schema !== REPLY_RECEIPT_SCHEMA || receipt.company_id !== proposal.company_id
    || receipt.source_event_id !== proposal.event_id || receipt.correlation_id !== proposal.correlation_id
    || !['proposed','duplicate'].includes(receipt.status) || receipt.action_executed !== false
    || !Number.isFinite(Date.parse(receipt.occurred_at))) throw new ReplyProtocolError('invalid_proposal_receipt',502);
  return receipt;
}
