/**
 * Governed communication-intent receiver. Does not send messages.
 * A DB-backed tenant resolver, consent verifier and atomic event ledger must be
 * supplied by the DB integration owner before this route is usable.
 */
import { createHash } from 'node:crypto';
import { BridgeProtocolError, parseCommunicationIntent, verifyBridgeRequest } from './protocol.mjs';
import { assertShadowTemplatePolicy } from './template-policy.mjs';

function ready(ports) {
  return !!ports && ['resolveCompany', 'verifyConsent', 'claimEvent', 'recordResult']
    .every(name => typeof ports[name] === 'function');
}
function reject(status, code) { return {status, body: {error: code}}; }

/**
 * @param {{body: Buffer, headers: Record<string, string|string[]|undefined>}} request
 * @param {{secret: string, ports: Object, now?: number}} options
 */
export async function receiveCommunicationIntent(request, options = {}) {
  if (!ready(options.ports)) return reject(503, 'identity_or_ledger_not_configured');
  const rawBody = request?.body;
  if (!Buffer.isBuffer(rawBody)) return reject(400, 'raw_body_required');
  if (rawBody.length > 8192) return reject(413, 'invalid_body_size');
  try {
    verifyBridgeRequest({
      rawBody, secret: options.secret,
      timestamp: request.headers?.['x-titan-bridge-timestamp'],
      signature: request.headers?.['x-titan-bridge-signature'],
      now: options.now ?? Date.now()
    });
    const intent = parseCommunicationIntent(rawBody, {now: options.now ?? Date.now()});
    assertShadowTemplatePolicy(intent);
    // This must be a trusted company↔Desk binding, never an owner picked by query order.
    const mapping = await options.ports.resolveCompany(intent.company_id);
    if (!mapping || mapping.company_id !== intent.company_id || !mapping.desk_user_id || mapping.active !== true)
      return reject(403, 'company_not_authorized');
    const consent = await options.ports.verifyConsent({intent, mapping});
    if (consent !== true) return reject(403, 'consent_not_verified');
    // claimEvent MUST be an atomic durable ledger operation keyed by company+event.
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const claim = await options.ports.claimEvent({companyId: intent.company_id, eventId: intent.event_id,
      correlationId: intent.correlation_id, payloadHash, intent, deskUserId: mapping.desk_user_id});
    if (claim?.state === 'duplicate') {
      // An in-flight claim with no durable result is NOT a successful replay.
      if (claim.payloadHash !== payloadHash || !claim.receipt || claim.receipt.source_event_id !== intent.event_id)
        return reject(409, 'event_claimed_pending_or_conflicting');
      return {status: 200, body: {...claim.receipt, status: 'duplicate'}};
    }
    if (claim?.state === 'conflict') return reject(409, 'event_id_conflict');
    if (claim?.state !== 'claimed') return reject(503, 'ledger_unavailable');
    const receipt = {
      schema: 'titan.field-desk.communication-result.v1',
      source_event_id: intent.event_id, correlation_id: intent.correlation_id,
      company_id: intent.company_id,
      status: 'simulated', delivery_status: 'not_sent',
      reason: 'shadow_mode_no_provider_dispatch',
      occurred_at: new Date(options.now ?? Date.now()).toISOString()
    };
    await options.ports.recordResult({intent, mapping, receipt});
    return {status: 202, body: receipt};
  } catch (error) {
    if (error instanceof BridgeProtocolError) return reject(error.httpStatus, error.code);
    // Do not disclose tenant IDs, raw payload, provider errors or DB exception text.
    return reject(503, 'bridge_dependency_unavailable');
  }
}
