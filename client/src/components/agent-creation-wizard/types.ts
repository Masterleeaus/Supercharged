import type { Dispatch, SetStateAction } from "react";
import type { Phone } from "lucide-react";

export interface SipPhoneNumber {
  id: string;
  phoneNumber: string;
  label?: string;
  trunkId: string;
  engine: string;
}

export interface UseCase {
  id: string;
  title: string;
  description: string;
  icon: typeof Phone;
  color: string;
  presetVoiceTone: string;
  presetPersonality: string;
  suggestedPrompt: string;
  suggestedFirstMessage: string;
  suggestedVoiceStyle: "professional" | "friendly" | "casual" | "authoritative";
}

export type WizardStep = "useCase" | "basics" | "personality" | "prompts" | "voice" | "review";

export interface WizardFormData {
  useCase: string;
  name: string;
  elevenLabsVoiceId: string;
  language: string;
  voiceTone: string;
  personality: string;
  systemPrompt: string;
  firstMessage: string;
  voiceStability: number;
  voiceSimilarityBoost: number;
  voiceSpeed: number;
  turnTimeout: number;
  telephonyProvider: "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine";
  openaiVoice: string;
  sipPhoneNumberId: string;
}

export type WizardFormSetter = Dispatch<SetStateAction<WizardFormData>>;
