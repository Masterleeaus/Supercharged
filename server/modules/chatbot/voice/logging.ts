/**
 * Log shape for the voice pipeline. Audio and transcript text never reach a log.
 *
 * The voice service builds every log entry through safeLogFields, which keeps only the keys below. Anything else
 * (audio bytes, transcript text, reply text, phone numbers, provider payloads) is dropped, even if a caller passes it.
 */

export interface VoiceLogFields {
  event: string;
  companyId?: string;
  sessionId?: string;
  seq?: number;
  /** Short machine code, such as limit_reached or transcription_failed. Never a provider message body. */
  code?: string;
  durationMs?: number | null;
}

export type VoiceLogger = (fields: VoiceLogFields) => void;

const ALLOWED_KEYS = ["event", "companyId", "sessionId", "seq", "code", "durationMs"] as const;

export function safeLogFields(input: Readonly<Record<string, unknown>>): VoiceLogFields {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    if (key in input && input[key] !== undefined) out[key] = input[key];
  }
  if (typeof out.event !== "string") out.event = "voice.unnamed";
  return out as unknown as VoiceLogFields;
}
