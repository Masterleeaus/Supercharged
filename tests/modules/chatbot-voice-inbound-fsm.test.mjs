import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInboundSession, reduceInbound } from '../../server/modules/chatbot/voice-call/inbound/fsm.ts';
import { InboundRegistry } from '../../server/modules/chatbot/voice-call/inbound/registry.ts';
import { routeVoiceProvider, recordOutcome, isAvailable, BREAKER_COOLDOWN_MS } from '../../server/modules/chatbot/voice-call/inbound/routing.ts';
import { buildHandoffBrief, maskCaller, maskDigits } from '../../server/modules/chatbot/voice-call/inbound/handoff.ts';

const C = 'company-a';
const CALL = 'call-1';
const ev = (type, extra = {}) => ({ type, companyId: C, callId: CALL, ...extra });

function run(events) {
  let s = newInboundSession(C, CALL);
  const effects = [];
  for (const e of events) {
    const r = reduceInbound(s, e, s.version);
    assert.equal(r.ok, true, `event ${e.type} rejected: ${r.reason}`);
    s = r.session;
    effects.push(...r.effects);
  }
  return { s, effects };
}

test('happy path: disclosure, consent, active, hangup', () => {
  const { s, effects } = run([
    ev('answered'), ev('disclosure_played'), ev('consent_given'), ev('caller_speech', { urgent: false }), ev('hangup'),
  ]);
  assert.equal(s.state, 'ended');
  assert.equal(s.endReason, 'hangup');
  assert.equal(s.consent, true);
  assert.deepEqual(effects[0], { type: 'play_disclosure' });
  assert.ok(effects.some((e) => e.type === 'request_consent'));
});

test('caller speech before consent is refused, nothing is processed', () => {
  let s = newInboundSession(C, CALL);
  s = reduceInbound(s, ev('answered'), 0).session;
  s = reduceInbound(s, ev('disclosure_played'), 1).session;
  const r = reduceInbound(s, ev('caller_speech', { urgent: true }), s.version);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'consent_required');
});

test('consent declined ends the call with no further speech accepted', () => {
  const { s } = run([ev('answered'), ev('disclosure_played'), ev('consent_declined')]);
  assert.equal(s.endReason, 'consent_declined');
  assert.equal(s.consent, false);
  const r = reduceInbound(s, ev('caller_speech', { urgent: false }), s.version);
  assert.equal(r.reason, 'already_ended');
});

test('barge-in during disclosure replays it; barge-in while active stops playback only', () => {
  const a = run([ev('answered'), ev('disclosure_interrupted')]);
  assert.equal(a.s.state, 'disclosing');
  assert.ok(a.effects.some((e) => e.type === 'replay_disclosure'));
  const b = run([ev('answered'), ev('disclosure_played'), ev('consent_given'), ev('caller_interrupted')]);
  assert.equal(b.s.state, 'active');
  assert.equal(b.s.bargeIns, 1);
  assert.deepEqual(b.effects.at(-1), { type: 'stop_playback' });
});

test('silence twice ends the call; speech resets the silence count', () => {
  const base = [ev('answered'), ev('disclosure_played'), ev('consent_given')];
  const { s } = run([...base, ev('silence_timeout'), ev('caller_speech', { urgent: false }), ev('silence_timeout')]);
  assert.equal(s.state, 'active');
  const dead = run([...base, ev('silence_timeout'), ev('silence_timeout')]);
  assert.equal(dead.s.endReason, 'silence_timeout');
});

test('urgent speech escalates to a warm handoff; accepted hands to staff', () => {
  const { s, effects } = run([
    ev('answered'), ev('disclosure_played'), ev('consent_given'), ev('caller_speech', { urgent: true }), ev('handoff_accepted'),
  ]);
  assert.equal(s.state, 'handoff');
  assert.ok(effects.some((e) => e.type === 'start_handoff' && e.reason === 'urgent'));
  assert.ok(effects.some((e) => e.type === 'connect_staff'));
});

test('handoff unavailable twice takes a message instead of looping', () => {
  const { s, effects } = run([
    ev('answered'), ev('disclosure_played'), ev('consent_given'), ev('caller_speech', { urgent: true }),
    ev('handoff_unavailable'), ev('handoff_unavailable'),
  ]);
  assert.equal(s.endReason, 'handoff_failed');
  assert.ok(effects.some((e) => e.type === 'take_message'));
});

test('provider errors reconnect until the budget is used, then fall back to a person', () => {
  const base = [ev('answered'), ev('disclosure_played'), ev('consent_given')];
  const one = run([...base, ev('provider_error')]);
  assert.equal(one.s.state, 'active');
  assert.deepEqual(one.effects.at(-1), { type: 'reconnect_provider' });
  const down = run([...base, ev('provider_error'), ev('provider_error'), ev('provider_error')]);
  assert.equal(down.s.state, 'escalating');
  assert.ok(down.effects.some((e) => e.type === 'start_handoff' && e.reason === 'provider_down'));
});

test('provider error during handoff ends the call as provider_failed', () => {
  const { s } = run([
    ev('answered'), ev('disclosure_played'), ev('consent_given'), ev('caller_speech', { urgent: true }), ev('handoff_accepted'),
    ev('provider_error'), ev('provider_error'), ev('provider_error'),
  ]);
  assert.equal(s.endReason, 'provider_failed');
});

test('max duration ends the call from any live state', () => {
  const { s } = run([ev('answered'), ev('max_duration')]);
  assert.equal(s.endReason, 'limit_reached');
});

test('spoofed or cross-company event is rejected before any state change', () => {
  const s = newInboundSession(C, CALL);
  const wrongCompany = reduceInbound(s, { ...ev('answered'), companyId: 'company-b' }, 0);
  assert.equal(wrongCompany.reason, 'call_mismatch');
  const wrongCall = reduceInbound(s, { ...ev('answered'), callId: 'other' }, 0);
  assert.equal(wrongCall.reason, 'call_mismatch');
  assert.equal(s.state, 'ringing');
});

test('duplicate delivery of the same event is applied once (stale version)', () => {
  let s = newInboundSession(C, CALL);
  const first = reduceInbound(s, ev('answered'), 0);
  assert.equal(first.ok, true);
  const replay = reduceInbound(first.session, ev('answered'), 0);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'stale_version');
});

test('registry: two concurrent events on the same version, only one wins', () => {
  const reg = new InboundRegistry();
  reg.open(C, CALL);
  const a = reg.apply(C, CALL, 0, ev('answered'));
  const b = reg.apply(C, CALL, 0, ev('answered'));
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(reg.get(C, CALL).state, 'disclosing');
});

test('registry: a call id from one company never reaches another company', () => {
  const reg = new InboundRegistry();
  reg.open(C, CALL);
  assert.equal(reg.get('company-b', CALL), null);
  const r = reg.apply('company-b', CALL, 0, { ...ev('answered'), companyId: 'company-b' });
  assert.equal(r.ok, false);
  assert.equal(reg.get(C, CALL).state, 'ringing');
});

test('routing: prefers the caller language, falls back when none matches', () => {
  const providers = [
    { id: 'p-en', languages: ['en'], priority: 1 },
    { id: 'p-es', languages: ['es'], priority: 2 },
  ];
  assert.deepEqual(routeVoiceProvider(providers, {}, 'es-MX', 0), { type: 'provider', providerId: 'p-es', language: 'es', fellBack: false });
  assert.deepEqual(routeVoiceProvider(providers, {}, 'fr', 0), { type: 'provider', providerId: 'p-en', language: 'fr', fellBack: true });
});

test('routing: a provider with an open breaker is skipped (downtime failover)', () => {
  const providers = [
    { id: 'primary', languages: ['en'], priority: 1 },
    { id: 'backup', languages: ['en'], priority: 2 },
  ];
  let b = { failures: 0, openUntil: null };
  for (let i = 0; i < 3; i++) b = recordOutcome(b, false, 1000);
  assert.equal(isAvailable(b, 1000), false);
  const d = routeVoiceProvider(providers, { primary: b }, 'en', 1000);
  assert.equal(d.providerId, 'backup');
  const later = routeVoiceProvider(providers, { primary: b }, 'en', 1000 + BREAKER_COOLDOWN_MS);
  assert.equal(later.providerId, 'primary');
});

test('routing: no available provider returns none so the call goes to a message', () => {
  const providers = [{ id: 'only', languages: ['en'], priority: 1 }];
  let b = { failures: 0, openUntil: null };
  for (let i = 0; i < 3; i++) b = recordOutcome(b, false, 0);
  assert.deepEqual(routeVoiceProvider(providers, { only: b }, 'en', 0), { type: 'none', reason: 'no_available_provider' });
});

test('breaker: success resets failures', () => {
  let b = recordOutcome({ failures: 0, openUntil: null }, false, 0);
  b = recordOutcome(b, true, 0);
  assert.equal(b.failures, 0);
});

test('handoff: transcript is included only with consent and is capped and masked', () => {
  const turns = Array.from({ length: 25 }, (_, i) => ({ speaker: 'caller', text: `msg ${i} call 0412345678` }));
  const withConsent = buildHandoffBrief({ reason: 'urgent', consent: true, callerNumber: '+61 412 345 678', turns });
  assert.equal(withConsent.transcriptIncluded, true);
  assert.equal(withConsent.transcript.length, 20);
  assert.ok(!withConsent.transcript[0].text.includes('0412345678'));
  assert.equal(withConsent.callerNumberMasked, '*******5678');
});

test('handoff: without consent the transcript is withheld entirely', () => {
  const brief = buildHandoffBrief({ reason: 'caller_request', consent: null, callerNumber: '0412345678', turns: [{ speaker: 'caller', text: 'hi' }] });
  assert.equal(brief.transcriptIncluded, false);
  assert.deepEqual(brief.transcript, []);
  assert.ok(brief.notes.some((n) => n.includes('withheld')));
});

test('handoff: masking helpers hide all but the last four digits', () => {
  assert.equal(maskCaller('12'), '****');
  assert.equal(maskDigits('call 0412345678 now'), 'call ******5678 now');
});
