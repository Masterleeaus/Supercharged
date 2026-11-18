// Adapter boundary for #333. Telephony (call control) and speech (TTS/STT) are separate modules.
// The FSM never imports these. An adapter performs effects it is given and reports back events.

export interface TelephonyAdapter {
  answer(companyId: string, callId: string): Promise<void>;
  transferTo(companyId: string, callId: string, staffNumber: string): Promise<void>;
  hangup(companyId: string, callId: string): Promise<void>;
}

export interface SpeechAdapter {
  speak(companyId: string, callId: string, text: string): Promise<void>;
  stop(companyId: string, callId: string): Promise<void>;
}
