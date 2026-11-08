/**
 * Speech-to-text and text-to-speech adapters behind the SpeechToText and TextToSpeech contracts.
 *
 * Both call the Gemini generateContent endpoint through the injected HttpClient, with a timeout on every request.
 * Audio travels as base64 inside the JSON body, which is why the contract's string-body HttpRequest can carry it.
 * The API key comes from the caller's key source (the environment or the company's encrypted credentials), is sent
 * in the x-goog-api-key header only, and never appears in an error message or a log line.
 *
 * Audio is never stored or logged here. Errors carry a short code and an HTTP status, never the body.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import type {
  AudioInput,
  HttpClient,
  SpeechOutput,
  SpeechSynthesisInput,
  SpeechToText,
  TextToSpeech,
  Transcript,
} from "../contracts/index.ts";

export const SPEECH_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Audio types the speech-to-text endpoint accepts. Browser webm recordings are refused, not sent. */
export const STT_MIME_TYPES: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
]);

const MODEL_ID = /^[A-Za-z0-9._-]{1,100}$/;

export type SpeechErrorCode =
  | "bad_model"
  | "no_key"
  | "unsupported_audio"
  | "unsupported_format"
  | "empty_input"
  | "provider_status"
  | "bad_response";

export class SpeechAdapterError extends Error {
  readonly code: SpeechErrorCode;
  readonly status: number | null;

  constructor(code: SpeechErrorCode, status: number | null = null) {
    super(status === null ? `speech adapter: ${code}` : `speech adapter: ${code} (${status})`);
    this.name = "SpeechAdapterError";
    this.code = code;
    this.status = status;
  }
}

/** Returns the company's key for the speech provider, or null when none is configured. */
export type SpeechKeySource = (companyId: string) => Promise<string | null>;

export interface GeminiSpeechOptions {
  keys: SpeechKeySource;
  /** Model id for generateContent. Chosen by the caller. */
  model: string;
  baseUrl?: string;
}

function checkModel(model: string): string {
  if (!MODEL_ID.test(model)) throw new SpeechAdapterError("bad_model");
  return model;
}

async function keyFor(keys: SpeechKeySource, companyId: string): Promise<string> {
  const key = await keys(requireCompanyId(companyId));
  if (!key || key.trim().length === 0) throw new SpeechAdapterError("no_key");
  return key.trim();
}

async function postGenerate(http: HttpClient, url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const response = await http({
    method: "POST",
    url,
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (response.status < 200 || response.status > 299) throw new SpeechAdapterError("provider_status", response.status);
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new SpeechAdapterError("bad_response");
  }
}

type Part = { text?: unknown; inlineData?: { mimeType?: unknown; data?: unknown } };

function firstParts(json: unknown): Part[] {
  const candidates = (json as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) throw new SpeechAdapterError("bad_response");
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts)) throw new SpeechAdapterError("bad_response");
  return parts as Part[];
}

// ---------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------

export function createGeminiSpeechToText(options: GeminiSpeechOptions): SpeechToText {
  const model = checkModel(options.model);
  const baseUrl = options.baseUrl ?? SPEECH_GEMINI_BASE_URL;

  return {
    async transcribe(companyId, audio: AudioInput, request, http: HttpClient): Promise<Transcript> {
      const mimeType = audio.mimeType.trim().toLowerCase();
      if (!STT_MIME_TYPES.has(mimeType)) throw new SpeechAdapterError("unsupported_audio");
      if (audio.bytes.byteLength === 0) throw new SpeechAdapterError("empty_input");
      const apiKey = await keyFor(options.keys, companyId);

      const languageHint = request.language ? ` The speaker uses the language with code ${request.language.replace(/[^A-Za-z-]/g, "")}.` : "";
      const body = {
        contents: [
          {
            parts: [
              { text: `Transcribe this audio exactly. Reply with the transcript only, no commentary.${languageHint}` },
              { inlineData: { mimeType, data: Buffer.from(audio.bytes).toString("base64") } },
            ],
          },
        ],
      };
      const json = await postGenerate(http, `${baseUrl}/models/${model}:generateContent`, apiKey, body, request.timeoutMs);
      const text = firstParts(json)
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
      return { text, language: request.language, confidence: null, segments: [], provider: "gemini" };
    },
  };
}

// ---------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------

/** Wraps raw 16-bit little-endian PCM in a RIFF/WAVE header. Pure: no I/O. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const dataLength = pcm.byteLength;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);
  out.set(pcm, 44);
  return out;
}

/** Reads the sample rate from a mime type such as audio/L16;codec=pcm;rate=24000. Defaults to 24000. */
export function sampleRateFromMime(mimeType: string): number {
  const match = /rate=(\d{4,6})/i.exec(mimeType);
  return match ? Number(match[1]) : 24000;
}

export interface GeminiTtsOptions extends GeminiSpeechOptions {}

export function createGeminiTextToSpeech(options: GeminiTtsOptions): TextToSpeech {
  const model = checkModel(options.model);
  const baseUrl = options.baseUrl ?? SPEECH_GEMINI_BASE_URL;

  return {
    async synthesize(companyId, input: SpeechSynthesisInput, http: HttpClient): Promise<SpeechOutput> {
      if (input.format !== "wav") throw new SpeechAdapterError("unsupported_format");
      const text = input.text.trim();
      if (text.length === 0) throw new SpeechAdapterError("empty_input");
      const apiKey = await keyFor(options.keys, companyId);

      const body = {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } } },
        },
      };
      const json = await postGenerate(http, `${baseUrl}/models/${model}:generateContent`, apiKey, body, input.timeoutMs);
      const inline = firstParts(json).find((part) => part.inlineData !== undefined)?.inlineData;
      if (!inline || typeof inline.data !== "string" || typeof inline.mimeType !== "string") throw new SpeechAdapterError("bad_response");
      const pcm = Uint8Array.from(Buffer.from(inline.data, "base64"));
      if (pcm.byteLength === 0) throw new SpeechAdapterError("bad_response");
      return { audio: pcmToWav(pcm, sampleRateFromMime(inline.mimeType)), mimeType: "audio/wav", provider: "gemini" };
    },
  };
}
