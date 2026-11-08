/**
 * Titan Field ↔ Desk transport v1. No database/provider dependencies.
 * Both independently deployed apps intentionally share this exact wire module
 * until a versioned shared package can be published and consumed by both.
 */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const WIRE_SCHEMA = 'titan.field-desk.communication-intent.v1';
export const MAX_BODY_BYTES = 8192;
export const MAX_CLOCK_SKEW_SECONDS = 300;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const TEMPLATE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CHANNELS = new Set(['sms', 'email']);
const RESOURCE_KINDS = new Set(['visit', 'job', 'invoice', 'estimate', 'booking_request']);

export class BridgeProtocolError extends Error {
  constructor(code, httpStatus = 422) { super(code); this.code = code; this.httpStatus = httpStatus; }
}

function checkId(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value))
    throw new BridgeProtocolError(`invalid_${field}`);
  return value;
}
function obj(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BridgeProtocolError(`invalid_${field}`);
  return value;
}
function exactKeys(input, keys, field) {
  const allowed = new Set(keys);
  if (Object.keys(input).some(k => !allowed.has(k)))
    throw new BridgeProtocolError(`unexpected_${field}_field`);
}
function iso(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new BridgeProtocolError(`invalid_${field}`);
  return value;
}
function isPlainObject(value) { return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }

export function parseCommunicationIntent(raw, { now = Date.now() } = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '');
  if (!bytes.length || bytes.length > MAX_BODY_BYTES) throw new BridgeProtocolError('invalid_body_size', 413);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new BridgeProtocolError('invalid_json', 400); }
  const v = obj(parsed, 'body');
  exactKeys(v, ['schema', 'event_id', 'correlation_id', 'company_id', 'requested_at', 'channel', 'template_key', 'recipient', 'resource', 'consent'], 'body');
  if (v.schema !== WIRE_SCHEMA) throw new BridgeProtocolError('unsupported_schema');
  for (const name of ['event_id', 'correlation_id', 'company_id']) checkId(v[name], name);
  iso(v.requested_at, 'requested_at');
  if (Math.abs(now - Date.parse(v.requested_at)) > 24 * 60 * 60 * 1000)
    throw new BridgeProtocolError('stale_event');
  if (!CHANNELS.has(v.channel)) throw new BridgeProtocolError('unsupported_channel');
  if (typeof v.template_key !== 'string' || !TEMPLATE_PATTERN.test(v.template_key))
    throw new BridgeProtocolError('invalid_template_key');
  const recipient = obj(v.recipient, 'recipient');
  exactKeys(recipient, ['kind','reference'], 'recipient');
  if (recipient.kind !== 'field_client') throw new BridgeProtocolError('invalid_recipient_kind');
  checkId(recipient.reference, 'recipient_reference');
  const resource = obj(v.resource, 'resource');
  exactKeys(resource, ['kind','reference'], 'resource');
  if (!RESOURCE_KINDS.has(resource.kind)) throw new BridgeProtocolError('invalid_resource_kind');
  checkId(resource.reference, 'resource_reference');
  const consent = obj(v.consent, 'consent');
  exactKeys(consent, ['evidence_reference','recorded_at'], 'consent');
  checkId(consent.evidence_reference, 'consent_evidence_reference');
  iso(consent.recorded_at, 'consent_recorded_at');
  if (Date.parse(consent.recorded_at) > now + 60000) throw new BridgeProtocolError('future_consent');
  // No phone number, email, message text, provider credential, or customer record is allowed.
  if (!isPlainObject(v)) throw new BridgeProtocolError('invalid_body');
  return v;
}

export function assertBridgeSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || secret.trim() !== secret)
    throw new BridgeProtocolError('bridge_secret_unconfigured', 503);
  return secret;
}

export function signBridgeRequest({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  assertBridgeSecret(secret);
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  if (!bytes.length || bytes.length > MAX_BODY_BYTES) throw new BridgeProtocolError('invalid_body_size', 413);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new BridgeProtocolError('invalid_timestamp', 400);
  return createHmac('sha256', secret).update(String(timestamp)).update('.').update(bytes).digest('hex');
}

export function verifyBridgeRequest({ rawBody, secret, timestamp, signature, now = Date.now() }) {
  assertBridgeSecret(secret);
  if (typeof timestamp !== 'string' || !/^\d{10,12}$/.test(timestamp))
    throw new BridgeProtocolError('unauthorized', 401);
  const time = Number(timestamp);
  if (!Number.isSafeInteger(time) || Math.abs(now / 1000 - time) > MAX_CLOCK_SKEW_SECONDS)
    throw new BridgeProtocolError('unauthorized', 401);
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature))
    throw new BridgeProtocolError('unauthorized', 401);
  const expected = signBridgeRequest({ rawBody, secret, timestamp: time });
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex')))
    throw new BridgeProtocolError('unauthorized', 401);
  return true;
}

export function createCommunicationIntent({companyId, eventId = randomUUID(), correlationId = randomUUID(),
    channel, templateKey, clientReference, resourceKind, resourceReference, consentEvidenceReference,
    consentRecordedAt, requestedAt = new Date().toISOString(), validationNow = Date.now()}) {
  const intent = {
    schema: WIRE_SCHEMA, event_id: eventId, correlation_id: correlationId,
    company_id: companyId, requested_at: requestedAt, channel, template_key: templateKey,
    recipient: {kind: 'field_client', reference: clientReference},
    resource: {kind: resourceKind, reference: resourceReference},
    consent: {evidence_reference: consentEvidenceReference, recorded_at: consentRecordedAt}
  };
  parseCommunicationIntent(JSON.stringify(intent), {now:validationNow});
  return intent;
}
