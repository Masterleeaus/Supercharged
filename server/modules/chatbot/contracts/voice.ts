/**
 * Voice port: speech-to-text, text-to-speech, call sessions, and the call provider. Flag: CHATBOT_VOICE_ENABLED.
 *
 * Audio is passed as bytes or as a provider-hosted reference. Audio is never written to logs. Transcripts are
 * tenant data and carry companyId.
 */
import type { HttpClient } from "./http.ts";

export interface AudioInput {
  mimeType: string;
  bytes: Uint8Array;
  /** Duration in milliseconds when known. */
  durationMs: number | null;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker: "customer" | "agent" | "unknown";
}

export interface Transcript {
  text: string;
  language: string | null;
  confidence: number | null;
  segments: TranscriptSegment[];
  provider: string;
}

export interface SpeechToText {
  transcribe(companyId: string, audio: AudioInput, options: { language: string | null; timeoutMs: number }, http: HttpClient): Promise<Transcript>;
}

export interface SpeechSynthesisInput {
  text: string;
  voice: string;
  language: string;
  format: "mp3" | "wav" | "ogg";
  timeoutMs: number;
}

export interface SpeechOutput {
  audio: Uint8Array;
  mimeType: string;
  provider: string;
}

export interface TextToSpeech {
  synthesize(companyId: string, input: SpeechSynthesisInput, http: HttpClient): Promise<SpeechOutput>;
}

export const CALL_SESSION_STATUSES = ["ringing", "in_progress", "completed", "failed", "no_answer"] as const;
export type CallSessionStatus = (typeof CALL_SESSION_STATUSES)[number];

export interface CallSession {
  id: string;
  companyId: string;
  chatbotId: string;
  conversationId: string | null;
  direction: "inbound" | "outbound";
  providerCallId: string;
  status: CallSessionStatus;
  fromNumber: string | null;
  toNumber: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  transcriptId: string | null;
}

export interface CallStartRequest {
  companyId: string;
  chatbotId: string;
  toNumber: string;
  fromNumber: string;
  /** URL the provider calls back on. Built by the caller, validated against the allow-list. */
  statusCallbackUrl: string;
  idempotencyKey: string;
}

export type CallProviderEvent =
  | { type: "call.ringing" | "call.answered" | "call.completed" | "call.failed"; providerCallId: string; occurredAt: Date }
  | { type: "call.transcript"; providerCallId: string; transcript: Transcript; occurredAt: Date }
  | { type: "other"; providerCallId: string | null; occurredAt: Date };

export interface CallWebhookInput {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
}

export interface CallProvider {
  readonly key: string;
  startCall(request: CallStartRequest, credentials: Readonly<Record<string, string>>, http: HttpClient): Promise<CallSession>;
  hangUp(companyId: string, providerCallId: string, credentials: Readonly<Record<string, string>>, http: HttpClient): Promise<boolean>;
  /** Fails closed. The legacy voice provider returns true for every request, which this contract does not allow. */
  verifyWebhook(companyId: string, input: CallWebhookInput, credentials: Readonly<Record<string, string>>): Promise<boolean>;
  parseWebhook(companyId: string, rawBody: string): CallProviderEvent[];
}
