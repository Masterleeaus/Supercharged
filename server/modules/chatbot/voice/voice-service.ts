/**
 * Voice chat service: start a session, take a turn, end a session.
 *
 * A turn runs: reserve seconds, speech-to-text, store the customer transcript, model reply, store the reply,
 * text-to-speech, record the turn. Seconds are given back when the turn produces no reply. Audio is passed in
 * and out as bytes; it is never stored and never logged. Transcripts are stored as messages in the conversation.
 *
 * Ports are injected: the speech, model and HTTP implementations, the chatbot and plan lookups, and the
 * conversation and message runtimes. No audio provider is named here.
 */
import { randomUUID } from "node:crypto";
import {
  CONTRACT_FLAGS,
  readFlag,
  type AudioInput,
  type ConversationRecord,
  type ConversationRuntime,
  type FlagEnv,
  type HttpClient,
  type MessageRecord,
  type MessageRuntime,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type SpeechOutput,
  type SpeechToText,
  type TextToSpeech,
} from "../contracts/index.ts";
import { isIdle, normalizeDurationMs, planLimitToMs } from "./limits.ts";
import { safeLogFields, type VoiceLogger } from "./logging.ts";
import type { VoiceEndReason, VoiceSessionRecord, VoiceSessionStorage } from "./voice-storage.ts";

// ---------------------------------------------------------------------------
// Ports owned by the voice folder (implemented by the integration step)
// ---------------------------------------------------------------------------

export interface VoiceChatbotProfile {
  id: string;
  title: string;
  language: string;
  instructions: string | null;
  welcomeMessage: string | null;
}

/** Tenant-scoped chatbot lookup. Returns null for a missing chatbot or one from another company. */
export interface VoiceChatbotLookup {
  load(companyId: string, chatbotId: string): Promise<VoiceChatbotProfile | null>;
}

/** Plan value for plans.voice_call_seconds_limit (-1 unlimited). Null when the company has no plan. */
export interface VoicePlanLimits {
  voiceCallSecondsLimit(companyId: string): Promise<number | null>;
}

/** Recent messages of one conversation, oldest first, in model-message form. Used as reply context. */
export interface VoiceTranscriptReader {
  recent(companyId: string, conversationId: string, limit: number): Promise<ModelMessage[]>;
}

export interface VoiceConfig {
  /** Model id passed to the ModelProvider. Chosen by the caller, not hard-coded here. */
  model: string;
  /** Default TTS voice id. A chatbot profile does not carry one yet. */
  voice: string;
  format: "mp3" | "wav" | "ogg";
  sttTimeoutMs: number;
  modelTimeoutMs: number;
  ttsTimeoutMs: number;
  historyLimit: number;
  maxOutputTokens: number;
  /** A session with no turn or step for this long is ended with reason idle. */
  idleTimeoutMs: number;
}

export const DEFAULT_VOICE_CONFIG: Omit<VoiceConfig, "model" | "voice"> = {
  // wav: the speech adapter in speech-gemini.ts returns wav only. Other formats fail and the reply goes out as text.
  format: "wav",
  sttTimeoutMs: 15_000,
  modelTimeoutMs: 20_000,
  ttsTimeoutMs: 15_000,
  historyLimit: 20,
  maxOutputTokens: 300,
  idleTimeoutMs: 5 * 60_000,
};

/** Appended to the chatbot's own instructions. Replies are spoken, so they should be short. */
export const VOICE_REPLY_RULE = "Answer in short sentences that suit being read aloud. Do not use markdown.";

export interface VoiceServiceDeps {
  env: FlagEnv;
  storage: VoiceSessionStorage;
  chatbots: VoiceChatbotLookup;
  plans: VoicePlanLimits;
  conversations: Pick<ConversationRuntime, "create">;
  messages: Pick<MessageRuntime, "create">;
  history: VoiceTranscriptReader;
  stt: SpeechToText;
  tts: TextToSpeech;
  models: Pick<ModelProvider, "complete">;
  http: HttpClient;
  config: VoiceConfig;
  now?: () => Date;
  newId?: () => string;
  log?: VoiceLogger;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type VoiceErrorCode =
  | "disabled"
  | "chatbot_not_found"
  | "not_found"
  | "session_ended"
  | "limit_reached"
  | "duration_required"
  | "empty_transcript"
  | "transcription_failed"
  | "reply_failed";

export type VoiceStartResult = { ok: true; session: VoiceSessionRecord } | { ok: false; code: VoiceErrorCode };

export type VoiceTurnResult =
  | {
      ok: true;
      seq: number;
      transcript: string;
      reply: string;
      /** Null when text-to-speech failed. The text reply is still returned. */
      audio: SpeechOutput | null;
      /** Milliseconds left in the session, null when unlimited. */
      remainingMs: number | null;
    }
  | { ok: false; code: VoiceErrorCode };

// ---------------------------------------------------------------------------
// Config validation (fails at construction, not on a live call)
// ---------------------------------------------------------------------------

function validateConfig(config: VoiceConfig): VoiceConfig {
  for (const key of ["sttTimeoutMs", "modelTimeoutMs", "ttsTimeoutMs", "historyLimit", "maxOutputTokens", "idleTimeoutMs"] as const) {
    const value = config[key];
    if (!Number.isInteger(value) || value <= 0) throw new Error(`voice config ${key} must be a positive integer`);
  }
  if (!config.model || !config.voice) throw new Error("voice config needs model and voice");
  return config;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createVoiceService(deps: VoiceServiceDeps) {
  const config = validateConfig(deps.config);
  const enabled = readFlag(CONTRACT_FLAGS.VOICE_ENABLED, deps.env);
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const log: VoiceLogger = deps.log ?? (() => undefined);
  const storage = deps.storage;

  async function startSession(companyId: string, input: { chatbotId: string }): Promise<VoiceStartResult> {
    if (!enabled) return { ok: false, code: "disabled" };
    const profile = input.chatbotId ? await deps.chatbots.load(companyId, input.chatbotId) : null;
    if (!profile) return { ok: false, code: "chatbot_not_found" };

    const conversation: ConversationRecord = await deps.conversations.create(companyId, {
      chatbotId: profile.id,
      channel: "voice",
      externalThreadId: null,
      customerId: null,
    });
    const limitMs = planLimitToMs(await deps.plans.voiceCallSecondsLimit(companyId));
    const session = await storage.create(companyId, {
      id: newId(),
      chatbotId: profile.id,
      conversationId: conversation.id,
      limitMs,
      startedAt: now(),
    });
    log(safeLogFields({ event: "voice.session.started", companyId, sessionId: session.id }));
    return { ok: true, session };
  }

  async function endSession(companyId: string, sessionId: string, reason: VoiceEndReason = "customer"): Promise<VoiceSessionRecord | null> {
    const ended = await storage.end(companyId, sessionId, reason, now());
    if (ended) log(safeLogFields({ event: "voice.session.ended", companyId, sessionId, code: reason }));
    return ended;
  }

  /**
   * Ends every active session of one company that has been idle for the idle timeout. A worker calls this on a
   * schedule. Each session is ended with a conditional write, so a session that another process ended first is
   * not counted again. Returns the number of sessions this call ended with reason idle.
   */
  async function expireIdleSessions(companyId: string, options: { limit?: number } = {}): Promise<number> {
    // Not gated by the flag: ending a session still works when voice is off, as in endSession.
    const at = now();
    const cutoff = new Date(at.getTime() - config.idleTimeoutMs);
    const idle = await storage.listIdle(companyId, cutoff, options.limit ?? 100);
    let ended = 0;
    for (const session of idle) {
      const result = await endSession(companyId, session.id, "idle");
      if (result && result.endReason === "idle") ended += 1;
    }
    return ended;
  }

  function systemPrompt(profile: VoiceChatbotProfile): string {
    return [profile.instructions?.trim(), VOICE_REPLY_RULE].filter((part) => part && part.length > 0).join("\n\n");
  }

  async function takeTurn(companyId: string, sessionId: string, audio: AudioInput): Promise<VoiceTurnResult> {
    if (!enabled) return { ok: false, code: "disabled" };

    const session = await storage.get(companyId, sessionId);
    if (!session) return { ok: false, code: "not_found" };
    if (session.status === "ended") return { ok: false, code: "session_ended" };
    // A turn that arrives after the idle timeout ends the session instead of taking the turn.
    if (isIdle(session.updatedAt, now(), config.idleTimeoutMs)) {
      await endSession(companyId, sessionId, "idle");
      return { ok: false, code: "session_ended" };
    }

    const profile = await deps.chatbots.load(companyId, session.chatbotId);
    if (!profile) return { ok: false, code: "chatbot_not_found" };

    const duration = normalizeDurationMs(audio.durationMs);
    if (!duration.ok || (session.limitMs !== null && duration.ms === null)) {
      return { ok: false, code: "duration_required" };
    }
    const charge = duration.ms ?? 0;

    const reserved = await storage.reserve(companyId, sessionId, charge);
    if (!reserved.ok) {
      if (reserved.reason === "limit_reached") {
        await endSession(companyId, sessionId, "limit_reached");
        log(safeLogFields({ event: "voice.turn.rejected", companyId, sessionId, code: "limit_reached" }));
        return { ok: false, code: "limit_reached" };
      }
      return { ok: false, code: reserved.reason === "not_found" ? "not_found" : "session_ended" };
    }

    const seq = reserved.seq;
    const giveBack = async () => storage.release(companyId, sessionId, charge);
    const fail = async (code: VoiceErrorCode): Promise<VoiceTurnResult> => {
      await giveBack();
      log(safeLogFields({ event: "voice.turn.failed", companyId, sessionId, seq, code, durationMs: duration.ms }));
      return { ok: false, code };
    };

    try {
      let transcriptText: string;
      try {
        const transcript = await deps.stt.transcribe(companyId, audio, { language: profile.language, timeoutMs: config.sttTimeoutMs }, deps.http);
        transcriptText = transcript.text.trim();
      } catch {
        return fail("transcription_failed");
      }
      if (transcriptText.length === 0) return fail("empty_transcript");

      const history = await deps.history.recent(companyId, session.conversationId, config.historyLimit);
      const customerMessage: MessageRecord = await deps.messages.create(companyId, session.conversationId, {
        role: "customer",
        staffId: null,
        contentKind: "text",
        text: transcriptText,
        attachmentIds: [],
        isInternalNote: false,
        idempotencyKey: `voice:${sessionId}:${seq}:customer`,
      });

      const request: ModelRequest = {
        model: config.model,
        messages: [{ role: "system", content: systemPrompt(profile) }, ...history, { role: "user", content: transcriptText }],
        timeoutMs: config.modelTimeoutMs,
        maxOutputTokens: config.maxOutputTokens,
        responseFormat: "text",
        purpose: "reply",
        conversationId: session.conversationId,
      };
      let replyText: string;
      try {
        const completion = await deps.models.complete(companyId, request);
        replyText = completion.text.trim();
        if (completion.finishReason === "error" || replyText.length === 0) return fail("reply_failed");
      } catch {
        return fail("reply_failed");
      }

      const assistantMessage: MessageRecord = await deps.messages.create(companyId, session.conversationId, {
        role: "assistant",
        staffId: null,
        contentKind: "text",
        text: replyText,
        attachmentIds: [],
        isInternalNote: false,
        idempotencyKey: `voice:${sessionId}:${seq}:assistant`,
      });

      let speech: SpeechOutput | null = null;
      try {
        speech = await deps.tts.synthesize(
          companyId,
          { text: replyText, voice: config.voice, language: profile.language, format: config.format, timeoutMs: config.ttsTimeoutMs },
          deps.http,
        );
      } catch {
        log(safeLogFields({ event: "voice.tts.failed", companyId, sessionId, seq, code: "tts_failed" }));
        speech = null;
      }

      await storage.recordTurn(companyId, sessionId, {
        seq,
        durationMs: duration.ms,
        customerMessageId: customerMessage.id,
        assistantMessageId: assistantMessage.id,
      });

      const remaining = reserved.session.limitMs === null ? null : Math.max(0, reserved.session.limitMs - reserved.session.usedMs);
      log(safeLogFields({ event: "voice.turn.ok", companyId, sessionId, seq, durationMs: duration.ms }));

      // The turn that uses up the last of the plan time ends the session now, so the next turn is refused.
      if (remaining === 0) await endSession(companyId, sessionId, "limit_reached");

      return { ok: true, seq, transcript: transcriptText, reply: replyText, audio: speech, remainingMs: remaining };
    } catch (error) {
      await giveBack();
      log(safeLogFields({ event: "voice.turn.error", companyId, sessionId, seq, code: "unexpected" }));
      throw error;
    }
  }

  async function getSession(companyId: string, sessionId: string): Promise<VoiceSessionRecord | null> {
    return storage.get(companyId, sessionId);
  }

  return { startSession, takeTurn, endSession, expireIdleSessions, getSession, enabled };
}

export type VoiceService = ReturnType<typeof createVoiceService>;
