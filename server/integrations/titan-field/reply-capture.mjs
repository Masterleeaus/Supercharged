/**
 * Desk-native adapter. It consumes a VERIFIED provider summary through an
 * injected verifier and a DB-agent-owned account/resource binding resolver.
 * The verifier must inspect provider signatures/credentials and MUST return a
 * new trusted object; never pass request JSON straight through as a verified event.
 * This module does not register a public webhook or mutate a Field job.
 */
import {createHash} from 'node:crypto';
import {parseReplyProposal, parseProposalReceipt, ReplyProtocolError, REPLY_SCHEMA} from './reply-protocol.mjs';

export class ReplyCaptureUnavailable extends Error {
  constructor(code){super(code);this.code=code;}
}
const actionMap = Object.freeze({
  booking_confirmed: 'confirm_visit', booking_reschedule: 'reschedule_request',
  quote_enquiry: 'request_quote', callback: 'request_callback',
  billing_enquiry: 'invoice_question', opt_out: 'opt_out_notice',
  unspecified: 'general_enquiry'
});
const identifier = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(x);
function trustedBinding(binding) {
  return !!binding && binding.active === true && identifier(binding.company_id)
    && identifier(binding.desk_user_id) && identifier(binding.client_reference)
    && identifier(binding.resource_reference) && identifier(binding.resource_kind);
}
function stableProviderEvent(company, provider, event) {
  return createHash('sha256').update(JSON.stringify(['desk-field-inbound.v1',company,provider,event])).digest('hex').slice(0,40);
}
/** @returns {{kind:'preview'|'shadow', proposal:Object, receipt?:Object}} */
export async function captureVerifiedDeskReply(providerInput, {
  verifyProviderEvent, resolveFieldContext, classify, submitProposal,
  dryRun = true, now = Date.now()
} = {}) {
  if (typeof verifyProviderEvent !== 'function' || typeof resolveFieldContext !== 'function'
      || typeof classify !== 'function' || (!dryRun && typeof submitProposal !== 'function'))
    throw new ReplyCaptureUnavailable('reply_capture_ports_required');
  if (!Number.isFinite(now)) throw new ReplyCaptureUnavailable('invalid_clock');
  // DO NOT take company_id from the original provider input. Verification and
  // provider-to-company mapping must be completed before constructing proposal.
  const verified = await verifyProviderEvent(providerInput);
  if (!verified || verified.verified !== true || !identifier(verified.provider)
      || !identifier(verified.provider_event_reference) || !identifier(verified.conversation_reference)
      || !identifier(verified.desk_record_reference) || typeof verified.occurred_at !== 'string'
      || !Number.isFinite(Date.parse(verified.occurred_at)) || !['sms','email','voice'].includes(verified.channel))
    throw new ReplyCaptureUnavailable('provider_event_not_verified');
  const binding = await resolveFieldContext(verified);
  if (!trustedBinding(binding)) throw new ReplyCaptureUnavailable('company_or_resource_not_verified');
  // A classifier is an untrusted recommender; its result is constrained by the
  // deterministic policy below and cannot request arbitrary Field mutations.
  const classification = await classify(verified);
  if (!classification || !Object.hasOwn(actionMap, classification.category)
      || !identifier(classification.classifier_version))
    throw new ReplyCaptureUnavailable('classification_not_approved');
  const proposal = {
    schema: REPLY_SCHEMA, company_id: binding.company_id,
    desk_user_id: binding.desk_user_id,
    event_id: stableProviderEvent(binding.company_id, verified.provider, verified.provider_event_reference),
    correlation_id: stableProviderEvent(binding.company_id,verified.provider,verified.conversation_reference),
    received_at: verified.occurred_at,
    source: {channel: verified.channel, provider_event_reference: verified.provider_event_reference,
      conversation_reference: verified.conversation_reference},
    resource: {kind: binding.resource_kind, reference: binding.resource_reference,
      client_reference: binding.client_reference},
    action: {kind: actionMap[classification.category], classifier_version: classification.classifier_version},
    evidence: {desk_record_reference:verified.desk_record_reference,provider_verified:true}
  };
  try {parseReplyProposal(JSON.stringify(proposal),{now});}
  catch (error) {
    if (error instanceof ReplyProtocolError) throw new ReplyCaptureUnavailable(error.code);
    throw error;
  }
  if (dryRun) return Object.freeze({kind:'preview',proposal:Object.freeze(proposal)});
  const response = await submitProposal(proposal);
  let receipt;
  try {receipt = parseProposalReceipt(response,proposal);}
  catch {throw new ReplyCaptureUnavailable('field_reply_receipt_invalid');}
  return Object.freeze({kind:'shadow',proposal:Object.freeze(proposal),receipt});
}
