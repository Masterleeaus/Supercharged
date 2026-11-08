# Voice chat pipeline: decisions

Source: `extensions/chatbot-voice/` and the voice migrations in `extensions/chatbot/database/migrations/` (2025_10_01 and 2025_10_02).
Behaviour decisions only. Each line says what changed from the PHP and why.

## Limits

- **Seconds limit is per voice session, not per company or billing period.** The PHP has no aggregate. The limit is copied from the plan when the session starts (`limit_ms`).
- **PHP never enforces `plans.voice_call_seconds_limit`.** The column exists and no code reads it. Enforcement here is new.
- **-1 means unlimited.** Matches the migration default. A missing plan (null) or a non-integer value fails closed to 0 ms.
- **Only customer audio is charged.** The caller's `durationMs` is charged. Synthesized speech length is not known to the port, so it is not charged.
- **Unknown duration is refused when the limit is finite.** Otherwise a caller could skip the limit.
- **A turn that would pass the limit is refused, and the session ends with `limit_reached`.** Its audio is not transcribed.
- **A turn that uses the last of the time ends the session at once.** The next turn gets `session_ended`.
- **Seconds are given back** when speech-to-text fails, the transcript is empty, the model fails, or an unexpected error is thrown.
- **Concurrent turns cannot both fit.** `reserve()` is one conditional UPDATE in Drizzle, and one synchronous check in the in-memory store.

## Transcripts and audio

- **Transcripts go to `chatbot_messages` through the MessageRuntime,** with role `customer` or `assistant`. PHP wrote to `ext_voicechatbot_histories` with role `user` or `agent`. The contract roles are used instead.
- **Audio is not stored anywhere.** The PHP keeps no audio. The synthesized reply is returned to the caller only.
- **Logs carry only fixed fields.** `safeLogFields` keeps event, companyId, sessionId, seq, code and durationMs. Transcripts, reply text and audio never reach a log.
- **A text-to-speech failure still returns the text reply.** The audio is null.
- **Message writes use idempotency keys** `voice:<sessionId>:<seq>:<role>`.

## Tenancy and state

- **A session is bound to one company and one chatbot.** A row from another company reads as absent (null or `not_found`). Starting with another company's chatbot id gives `chatbot_not_found`.
- **Voice is gated by `CHATBOT_VOICE_ENABLED`, read with `readFlag`.** The flag gates start and turns. Ending a session still works when it is off.
- **An ended session takes no turns.** Ending is idempotent, and the first endedAt and endReason are kept.

## Not ported

- **`Str::random($cost)` credit charge in `storeTranscripts`.** It spends credit by generating random characters. Not ported. Billing belongs to the usage layer.
- **`where('conversation_id')` with one argument in `storeConversation`.** A bug in the source. Not ported.
- **Unparenthesised `orWhere` in `loadConversationWithPaginate`.** It can leak another user's rows. Not ported.
- **`VoiceChannelProvider::verifyWebhook` returns true.** Contracts forbid it. No webhook is handled here.
- **ElevenLabs agent create, update, delete and knowledge-base sync.** Provider-side agent management is out of scope. No real provider is implemented.
- **The `CallProvider` (phone calls) contract is not implemented.** Only the chat voice pipeline is in this port.

## Changes from the source

- **TTS voice id comes from config.** `voice_call_voice_id` is not in `shared/schema.ts` yet.
- **The system prompt adds a spoken-reply rule.** Replies should be short and have no markdown. This is new behaviour.
- **Transcript history is read through an injected port** (`VoiceTranscriptReader`) because MessageRuntime has no read method.

## Open items for integration

- **Migration is numbered `0002_voice.sql`.** Another agent may use the same number. Renumber at integration.

## Completion pass (idle expiry, session-end event, speech adapters)

Files: `voice/outbox.ts` (new), `voice/speech-gemini.ts` (new), `voice/voice-storage.ts`, `voice/voice-service.ts`, `voice/limits.ts`. Tests: `tests/modules/chatbot-voice-completion.test.mjs`.

- **Idle timeout is 5 minutes** (`idleTimeoutMs`, config, validated as a positive integer). Idle is measured from `updated_at`, which reserve, release and end move. A turn that arrives after the timeout ends the session with reason `idle` and is refused as `session_ended`. No transcript is written for it.
- **`expireIdleSessions(companyId, { limit })`** is the function a worker calls. It ends only this company's idle sessions, each with a conditional write. It is not gated by the flag, because ending still works when voice is off.
- **New end reason `idle`.** The DB check constraint now allows it, in `db/voice.ts` and `db/migrations-draft/0002_voice.sql` (updated 2026-11-09). (UNVERIFIED against Postgres.)
- **One `voice.session.ended` outbox event per session end.** The Drizzle `end()` writes it in the same transaction as the state change, and only the call that changes the row writes it. Dedupe key `voice.session.ended:<sessionId>`. Payload: session, chatbot and conversation ids, end reason, turn count, used milliseconds, end time. No transcript, reply, audio or caller number.
- **Speech-to-text and text-to-speech** are Gemini adapters (`createGeminiSpeechToText`, `createGeminiTextToSpeech`). They use the injected HttpClient with a timeout on every call. Audio goes as base64 inside the JSON body, because `HttpRequest.body` is a string and a multipart upload cannot be sent through it.
- **Speech-to-text accepts** wav, mp3, aiff, aac, ogg and flac. Browser `audio/webm` is refused as `unsupported_audio`. The widget must send one of the accepted types, or the turn fails and the seconds are given back.
- **Text-to-speech returns wav only.** The raw PCM from the provider is wrapped in a WAV header. `DEFAULT_VOICE_CONFIG.format` changed from `mp3` to `wav` to match. Other formats fail, and the reply goes out as text with audio null.
- **Keys come from an injected per-company key source.** Nothing is read from the environment in the adapter. Errors carry a code and an HTTP status only, never the key or the response body.
- **Transcript write path is unchanged.** Transcripts already go through `MessageRuntime.create` with idempotency keys, and the conversation through `ConversationRuntime.create`. Nothing new was needed.
- **Memory storage takes an injected clock** (`now`), so idle tests do not depend on wall time.

### Change requests (outside this folder)

- `db/voice.ts` (`sessionEndReasonCheck`) and `db/migrations-draft/0002_voice.sql`: add `idle` to the end reason check. Done: both files now include it, so the idle path no longer fails the check (updated 2026-11-09).
- Events owner (events DECISIONS C4): name the realtime mapping for topic `voice.session.ended`, or confirm the relay skips it.
