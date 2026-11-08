/**
 * Demo call cap. Ported from VoiceCallController.php (chatbot-voice-call, store duration path).
 * In demo mode a call's duration is capped to the day's remaining demo seconds. The PHP default limit is 30 seconds
 * per day, read from the setting voice_call_demo_seconds_limit. The caller passes the setting value and today's used
 * seconds, so this module reads no storage and no environment.
 *
 * Decision (owner, 2026-11-09): port the timer now. The credit rate is NOT here: it lives in an external Entity
 * driver that is not in the uploaded source, so it stays a pluggable value to be supplied later.
 */
export const DEFAULT_DEMO_SECONDS_LIMIT = 30;

export interface DemoCapInput {
  /** Whether the app is in demo mode. The cap applies only when this is true. */
  isDemo: boolean;
  /** Duration the client asked to store, in whole seconds. */
  requestedSeconds: number;
  /** Today's total used demo seconds for this session, from storage. */
  usedTodaySeconds: number;
  /** Daily demo limit in seconds. Defaults to DEFAULT_DEMO_SECONDS_LIMIT. */
  limitSeconds?: number;
}

/** Returns the duration to store. Outside demo mode the requested duration is returned unchanged. */
export function capDemoDuration(input: DemoCapInput): number {
  const requested = Math.max(0, Math.floor(Number(input.requestedSeconds) || 0));
  if (!input.isDemo) return requested;
  const limit = Math.max(0, Math.floor(input.limitSeconds ?? DEFAULT_DEMO_SECONDS_LIMIT));
  const used = Math.max(0, Math.floor(Number(input.usedTodaySeconds) || 0));
  const remaining = Math.max(0, limit - used);
  return Math.min(requested, remaining);
}
