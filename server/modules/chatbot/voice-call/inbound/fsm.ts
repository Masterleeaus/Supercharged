// Inbound phone call session state machine (#333). Pure: no storage, no network, no clock.
// The caller provides `now` and every event. The reducer returns the next session and the
// effects to carry out. Adapters (telephony, speech) perform effects; they never decide them.
//
// Flow: ringing -> disclosing -> consent_pending -> active -> escalating -> handoff -> ended
// Rules that matter for safety:
//   - No caller speech is processed before the disclosure has played and consent is given.
//   - Consent declined ends the call. Nothing else is recorded beyond the outcome.
//   - Urgent speech moves to escalating with a warm handoff to staff.
//   - Duplicate or stale events are rejected by version, so a retried webhook cannot apply twice.
//   - An event for another call or company is rejected before any state changes.

export const INBOUND_STATES = [
  'ringing', 'disclosing', 'consent_pending', 'active', 'escalating', 'handoff', 'ended',
] as const;
export type InboundState = (typeof INBOUND_STATES)[number];

export type EndReason =
  | 'completed'
  | 'consent_declined'
  | 'silence_timeout'
  | 'limit_reached'
  | 'handoff_failed'
  | 'provider_failed'
  | 'hangup';

export const MAX_SILENCE_TIMEOUTS = 2;
export const MAX_PROVIDER_ERRORS = 3;
export const MAX_HANDOFF_ATTEMPTS = 2;

export interface InboundSession {
  companyId: string;
  callId: string;
  state: InboundState;
  version: number;
  consent: boolean | null;
  silenceTimeouts: number;
  providerErrors: number;
  handoffAttempts: number;
  bargeIns: number;
  endReason: EndReason | null;
}

export type InboundEvent =
  | { type: 'answered'; companyId: string; callId: string }
  | { type: 'disclosure_played'; companyId: string; callId: string }
  | { type: 'disclosure_interrupted'; companyId: string; callId: string }
  | { type: 'consent_given'; companyId: string; callId: string }
  | { type: 'consent_declined'; companyId: string; callId: string }
  | { type: 'caller_speech'; companyId: string; callId: string; urgent: boolean }
  | { type: 'caller_interrupted'; companyId: string; callId: string }
  | { type: 'silence_timeout'; companyId: string; callId: string }
  | { type: 'provider_error'; companyId: string; callId: string }
  | { type: 'handoff_accepted'; companyId: string; callId: string }
  | { type: 'handoff_unavailable'; companyId: string; callId: string }
  | { type: 'hangup'; companyId: string; callId: string }
  | { type: 'max_duration'; companyId: string; callId: string };

export type InboundEffect =
  | { type: 'play_disclosure' }
  | { type: 'replay_disclosure' }
  | { type: 'request_consent' }
  | { type: 'stop_playback' }
  | { type: 'reconnect_provider' }
  | { type: 'start_handoff'; reason: 'urgent' | 'provider_down' | 'caller_request' }
  | { type: 'retry_handoff' }
  | { type: 'connect_staff' }
  | { type: 'take_message' }
  | { type: 'end_call'; reason: EndReason };

export type ReduceResult =
  | { ok: true; session: InboundSession; effects: InboundEffect[] }
  | { ok: false; reason: 'call_mismatch' | 'stale_version' | 'invalid_for_state' | 'already_ended' | 'consent_required' };

export function newInboundSession(companyId: string, callId: string): InboundSession {
  return {
    companyId,
    callId,
    state: 'ringing',
    version: 0,
    consent: null,
    silenceTimeouts: 0,
    providerErrors: 0,
    handoffAttempts: 0,
    bargeIns: 0,
    endReason: null,
  };
}

function end(session: InboundSession, reason: EndReason, effects: InboundEffect[]): ReduceResult {
  return {
    ok: true,
    session: { ...session, state: 'ended', endReason: reason, version: session.version + 1 },
    effects: [...effects, { type: 'end_call', reason }],
  };
}

function move(session: InboundSession, state: InboundState, patch: Partial<InboundSession>, effects: InboundEffect[]): ReduceResult {
  return { ok: true, session: { ...session, ...patch, state, version: session.version + 1 }, effects };
}

/**
 * Applies one event. `expectedVersion` must equal the session's current version, so the caller
 * learns about a duplicate or out-of-order event instead of applying it twice.
 */
export function reduceInbound(session: InboundSession, event: InboundEvent, expectedVersion: number): ReduceResult {
  if (event.companyId !== session.companyId || event.callId !== session.callId) {
    return { ok: false, reason: 'call_mismatch' };
  }
  if (expectedVersion !== session.version) return { ok: false, reason: 'stale_version' };
  if (session.state === 'ended') return { ok: false, reason: 'already_ended' };

  // Hangup and max duration end the call from any live state.
  if (event.type === 'hangup') return end(session, 'hangup', []);
  if (event.type === 'max_duration') return end(session, 'limit_reached', []);

  // Provider errors reconnect while there is budget, then fall back to a person.
  if (event.type === 'provider_error') {
    const providerErrors = session.providerErrors + 1;
    if (providerErrors < MAX_PROVIDER_ERRORS) {
      return move(session, session.state, { providerErrors }, [{ type: 'reconnect_provider' }]);
    }
    if (session.state === 'handoff') return end(session, 'provider_failed', []);
    return move(session, 'escalating', { providerErrors }, [
      { type: 'start_handoff', reason: 'provider_down' },
    ]);
  }

  switch (session.state) {
    case 'ringing':
      if (event.type === 'answered') {
        return move(session, 'disclosing', {}, [{ type: 'play_disclosure' }]);
      }
      return { ok: false, reason: 'invalid_for_state' };

    case 'disclosing':
      if (event.type === 'disclosure_played') {
        return move(session, 'consent_pending', {}, [{ type: 'request_consent' }]);
      }
      if (event.type === 'disclosure_interrupted') {
        return move(session, 'disclosing', {}, [{ type: 'stop_playback' }, { type: 'replay_disclosure' }]);
      }
      return { ok: false, reason: 'invalid_for_state' };

    case 'consent_pending':
      if (event.type === 'consent_given') {
        return move(session, 'active', { consent: true }, []);
      }
      if (event.type === 'consent_declined') {
        return end({ ...session, consent: false }, 'consent_declined', []);
      }
      if (event.type === 'caller_speech' || event.type === 'caller_interrupted') {
        return { ok: false, reason: 'consent_required' };
      }
      return { ok: false, reason: 'invalid_for_state' };

    case 'active':
      if (event.type === 'caller_speech') {
        if (event.urgent) {
          return move(session, 'escalating', {}, [{ type: 'stop_playback' }, { type: 'start_handoff', reason: 'urgent' }]);
        }
        return move(session, 'active', { silenceTimeouts: 0 }, []);
      }
      if (event.type === 'caller_interrupted') {
        return move(session, 'active', { bargeIns: session.bargeIns + 1 }, [{ type: 'stop_playback' }]);
      }
      if (event.type === 'silence_timeout') {
        const silenceTimeouts = session.silenceTimeouts + 1;
        if (silenceTimeouts >= MAX_SILENCE_TIMEOUTS) return end({ ...session, silenceTimeouts }, 'silence_timeout', []);
        return move(session, 'active', { silenceTimeouts }, []);
      }
      return { ok: false, reason: 'invalid_for_state' };

    case 'escalating':
      if (event.type === 'handoff_accepted') {
        return move(session, 'handoff', {}, [{ type: 'connect_staff' }]);
      }
      if (event.type === 'handoff_unavailable') {
        const handoffAttempts = session.handoffAttempts + 1;
        if (handoffAttempts >= MAX_HANDOFF_ATTEMPTS) {
          return end({ ...session, handoffAttempts }, 'handoff_failed', [{ type: 'take_message' }]);
        }
        return move(session, 'escalating', { handoffAttempts }, [{ type: 'retry_handoff' }]);
      }
      return { ok: false, reason: 'invalid_for_state' };

    case 'handoff':
      return { ok: false, reason: 'invalid_for_state' };

    default:
      return { ok: false, reason: 'invalid_for_state' };
  }
}
