/**
 * W11 voice spike. Interface and a fake only. No provider is called.
 *
 * Scope rule: this module owns server/integrations/voltagent/voice/ only. It does not read
 * or edit the existing engines (plivo, plivo-elevenlabs, twilio-openai). The spike defines the
 * seam a VoltAgent voice provider would plug into. The @voltagent/voice API is NOT in the repo
 * and is NOT verified, so no call to it is made here.
 *
 * Disabled unless the voice flag is on. The disabled path returns a refusal and starts nothing.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 */
export interface VoiceTurn {
  companyId: string;
  sessionId: string;
  audio: Uint8Array;
}

export interface VoiceReply {
  text: string;
}

/** The seam a real provider implements later. The spike does not implement it. */
export interface VoiceProvider {
  transcribe(turn: VoiceTurn): Promise<string>;
  respond(companyId: string, sessionId: string, text: string): Promise<string>;
  synthesize(companyId: string, text: string): Promise<Uint8Array>;
}

export type VoiceResult =
  | { ok: true; reply: VoiceReply; audio: Uint8Array }
  | { ok: false; code: 'voice_disabled' | 'company_required' | 'empty_audio' | 'provider_failed'; message: string };

export interface VoiceSpikeOptions {
  enabled: boolean;
  provider: VoiceProvider;
}

export function createVoiceSpike(options: VoiceSpikeOptions) {
  const enabled = options.enabled === true;
  return {
    enabled,
    async handleTurn(turn: VoiceTurn): Promise<VoiceResult> {
      if (!enabled) return { ok: false, code: 'voice_disabled', message: 'voice is disabled' };
      if (typeof turn.companyId !== 'string' || turn.companyId.trim() === '') {
        return { ok: false, code: 'company_required', message: 'companyId is required' };
      }
      if (!(turn.audio instanceof Uint8Array) || turn.audio.byteLength === 0) {
        return { ok: false, code: 'empty_audio', message: 'audio is empty' };
      }
      try {
        const heard = await options.provider.transcribe(turn);
        const text = await options.provider.respond(turn.companyId, turn.sessionId, heard);
        const audio = await options.provider.synthesize(turn.companyId, text);
        return { ok: true, reply: { text }, audio };
      } catch (error) {
        return { ok: false, code: 'provider_failed', message: error instanceof Error ? error.message : 'provider failed' };
      }
    },
  };
}
