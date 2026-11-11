/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { useTranslation } from 'react-i18next';
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";



export interface SipPhoneNumber {
  id: string;
  phoneNumber: string;
  label?: string;
  trunkId: string;
  engine: string;
}

export const formatModelName = (modelName: string) => {
  if (!modelName) return '';
  // Strip language code suffix and format nicely
  const noLang = modelName.replace(/-(en|hi|fr|es|de|pt|it|ja|ko|zh|nl|pl|ru|sv|tr|uk|ta|te|th)$/i, '');
  return noLang.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

export interface Agent {
  id: string;
  type: 'incoming' | 'flow' | 'custom_engine';
  name: string;
  voiceTone: string;
  personality: string;
  systemPrompt: string;
  elevenLabsAgentId: string | null;
  elevenLabsVoiceId: string | null;
  agentLink: string | null;
  language: string | null;
  llmModel: string | null;
  firstMessage: string | null;
  temperature: number | null;
  knowledgeBaseIds: string[] | null;
  config: any;
  flowId: string | null;
  maxDurationSeconds: number | null;
  voiceStability: number | null;
  voiceSimilarityBoost: number | null;
  voiceSpeed: number | null;
  turnTimeout: number | null;
  transferEnabled: boolean | null;
  transferPhoneNumber: string | null;
  detectLanguageEnabled: boolean | null;
  endConversationEnabled: boolean | null;
  appointmentBookingEnabled: boolean | null;
  expressiveMode: boolean | null;
  telephonyProvider: 'twilio' | 'plivo' | 'twilio_openai' | 'elevenlabs-sip' | 'openai-sip' | 'custom-voice-engine' | null;
  openaiVoice: string | null;
  createdAt: string;
}

// OpenAI Realtime API voice options (for Plivo+OpenAI and Twilio+OpenAI engines)
export const openaiVoices = [
  { value: "alloy", label: "Alloy", description: "Versatile and balanced" },
  { value: "echo", label: "Echo", description: "Warm and confident" },
  { value: "shimmer", label: "Shimmer", description: "Clear and expressive" },
  { value: "ash", label: "Ash", description: "Soft and gentle" },
  { value: "ballad", label: "Ballad", description: "Melodic and soothing" },
  { value: "coral", label: "Coral", description: "Bright and friendly" },
  { value: "sage", label: "Sage", description: "Calm and wise" },
  { value: "verse", label: "Verse", description: "Poetic and articulate" },
  { value: "cedar", label: "Cedar", description: "Deep and grounded" },
  { value: "marin", label: "Marin", description: "Fresh and lively" },
];

export const customVoiceEngineVoices = [
  // Deepgram
  { value: "aura-asteria-en", label: "Asteria (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-luna-en", label: "Luna (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-stella-en", label: "Stella (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-athena-en", label: "Athena (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-hera-en", label: "Hera (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-orion-en", label: "Orion (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-arcas-en", label: "Arcas (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-perseus-en", label: "Perseus (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-angus-en", label: "Angus (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-orpheus-en", label: "Orpheus (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-helios-en", label: "Helios (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-zeus-en", label: "Zeus (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-2-asteria-en", label: "Asteria Aura-2 (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-2-luna-en", label: "Luna Aura-2 (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-2-stella-en", label: "Stella Aura-2 (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-2-athena-en", label: "Athena Aura-2 (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-2-hera-en", label: "Hera Aura-2 (Deepgram)", description: "English - Female", provider: "deepgram" as const },
  { value: "aura-2-orion-en", label: "Orion Aura-2 (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-2-arcas-en", label: "Arcas Aura-2 (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-2-perseus-en", label: "Perseus Aura-2 (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-2-angus-en", label: "Angus Aura-2 (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-2-orpheus-en", label: "Orpheus Aura-2 (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-2-helios-en", label: "Helios Aura-2 (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-2-zeus-en", label: "Zeus Aura-2 (Deepgram)", description: "English - Male", provider: "deepgram" as const },
  { value: "aura-2-amira-de", label: "Amira (Deepgram)", description: "German - Female", provider: "deepgram" as const },
  { value: "aura-2-lukas-de", label: "Lukas (Deepgram)", description: "German - Male", provider: "deepgram" as const },
  { value: "aura-2-rhea-nl", label: "Rhea (Deepgram)", description: "Dutch - Female", provider: "deepgram" as const },
  { value: "aura-2-nils-nl", label: "Nils (Deepgram)", description: "Dutch - Male", provider: "deepgram" as const },
  { value: "aura-2-chloe-fr", label: "Chloe (Deepgram)", description: "French - Female", provider: "deepgram" as const },
  { value: "aura-2-nicolas-fr", label: "Nicolas (Deepgram)", description: "French - Male", provider: "deepgram" as const },
  { value: "aura-2-bianca-it", label: "Bianca (Deepgram)", description: "Italian - Female", provider: "deepgram" as const },
  { value: "aura-2-giulio-it", label: "Giulio (Deepgram)", description: "Italian - Male", provider: "deepgram" as const },
  { value: "aura-2-akira-ja", label: "Akira (Deepgram)", description: "Japanese - Female", provider: "deepgram" as const },
  { value: "aura-2-hikari-ja", label: "Hikari (Deepgram)", description: "Japanese - Male", provider: "deepgram" as const },
  { value: "aura-2-carmen-es", label: "Carmen (Deepgram)", description: "Spanish - Female", provider: "deepgram" as const },
  { value: "aura-2-miguel-es", label: "Miguel (Deepgram)", description: "Spanish - Male", provider: "deepgram" as const },
  // Sarvam — Bulbul v3 (30+ speakers, model: "bulbul:v3")
  // Per-language recommended speakers from Sarvam API docs
  { value: "shubh", label: "Shubh (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["en", "hi", "te", "kn", "od", "ml"] },
  { value: "aditya", label: "Aditya (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "rahul", label: "Rahul (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "rohan", label: "Rohan (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["ta"] },
  { value: "amit", label: "Amit (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "dev", label: "Dev (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "ratan", label: "Ratan (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["en", "te", "kn", "ta", "mr", "gu"] },
  { value: "varun", label: "Varun (Sarvam)", description: "Male — dramatic/suspense", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "manan", label: "Manan (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "sumit", label: "Sumit (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "kabir", label: "Kabir (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "aayan", label: "Aayan (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "ashutosh", label: "Ashutosh (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["hi"] },
  { value: "advait", label: "Advait (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "anand", label: "Anand (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "tarun", label: "Tarun (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "sunny", label: "Sunny (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "mani", label: "Mani (Sarvam)", description: "Male — best overall CER", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["pa"] },
  { value: "gokul", label: "Gokul (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "vijay", label: "Vijay (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "mohit", label: "Mohit (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "rehan", label: "Rehan (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["bn"] },
  { value: "soham", label: "Soham (Sarvam)", description: "Male", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "priya", label: "Priya (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["hi", "te", "mr", "gu"] },
  { value: "neha", label: "Neha (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["te", "kn"] },
  { value: "ritu", label: "Ritu (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["ta", "od", "mr", "gu"] },
  { value: "pooja", label: "Pooja (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["od", "ml"] },
  { value: "simran", label: "Simran (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "kavya", label: "Kavya (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "ishita", label: "Ishita (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["en", "kn", "ta"] },
  { value: "shreya", label: "Shreya (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "roopa", label: "Roopa (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["bn", "pa"] },
  { value: "tanya", label: "Tanya (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "shruti", label: "Shruti (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "suhani", label: "Suhani (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const, languages: ["hi", "bn", "pa"] },
  { value: "kavitha", label: "Kavitha (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const },
  { value: "rupali", label: "Rupali (Sarvam)", description: "Female", provider: "sarvam" as const, model: "bulbul:v3" as const },
  // Sarvam — Bulbul v2 (7 speakers, model: "bulbul:v2")
  { value: "anushka", label: "Anushka (Sarvam)", description: "Female — default v2", provider: "sarvam" as const, model: "bulbul:v2" as const },
  { value: "manisha", label: "Manisha (Sarvam)", description: "Female — warm", provider: "sarvam" as const, model: "bulbul:v2" as const },
  { value: "vidya", label: "Vidya (Sarvam)", description: "Female — articulate", provider: "sarvam" as const, model: "bulbul:v2" as const },
  { value: "arya", label: "Arya (Sarvam)", description: "Female — energetic", provider: "sarvam" as const, model: "bulbul:v2" as const },
  { value: "abhilash", label: "Abhilash (Sarvam)", description: "Male — authoritative", provider: "sarvam" as const, model: "bulbul:v2" as const },
  { value: "karun", label: "Karun (Sarvam)", description: "Male — conversational", provider: "sarvam" as const, model: "bulbul:v2" as const },
  { value: "hitesh", label: "Hitesh (Sarvam)", description: "Male — professional", provider: "sarvam" as const, model: "bulbul:v2" as const },
];

export interface Voice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

export interface KnowledgeBaseItem {
  id: string;
  type: string;
  title: string;
  content?: string;
  url?: string;
  fileUrl?: string;
  elevenLabsDocId: string | null;
  storageSize: number;
  createdAt: string;
}

// LLM cost estimates per minute (in USD)
export const MODEL_COSTS: Record<string, { llm: number; name: string; speed: string }> = {
  // ElevenLabs Models
  "glm-45-air-fp8": { llm: 0.0106, name: "GLM-4.5-Air", speed: "Balanced" },
  "qwen3-30b-a3b": { llm: 0.0033, name: "Qwen3-30B-A3B", speed: "Ultra Fast" },
  "gpt-oss-120b": { llm: 0.02, name: "GPT-OSS-120B", speed: "High Quality" },

  // Google Models
  "gemini-2.5-flash": { llm: 0.005, name: "Gemini 2.5 Flash", speed: "Very Fast" },
  "gemini-2.5-flash-lite": { llm: 0.003, name: "Gemini 2.5 Flash Lite", speed: "Ultra Fast" },
  "gemini-2.0-flash": { llm: 0.004, name: "Gemini 2.0 Flash", speed: "Very Fast" },
  "gemini-2.0-flash-lite": { llm: 0.002, name: "Gemini 2.0 Flash Lite", speed: "Ultra Fast" },

  // OpenAI Models
  "gpt-4o": { llm: 0.02, name: "GPT-4o", speed: "Balanced" },
  "gpt-4o-mini": { llm: 0.006, name: "GPT-4o Mini", speed: "Fast" },
  "gpt-4-turbo": { llm: 0.04, name: "GPT-4 Turbo", speed: "High Quality" },
  "gpt-3.5-turbo": { llm: 0.003, name: "GPT-3.5 Turbo", speed: "Very Fast" },

  // Anthropic Models
  "claude-3-5-sonnet": { llm: 0.06, name: "Claude 3.5 Sonnet", speed: "High Quality" },
  "claude-3-haiku": { llm: 0.01, name: "Claude 3 Haiku", speed: "Fast" },
};

export const VOICE_COST = 0.10; // $0.10 per minute for voice service

export function EstimatedCost({ model }: { model: string }) {
  const { t } = useTranslation();
  const modelInfo = MODEL_COSTS[model];

  // Fetch LLM margin from admin settings
  const { data: marginData } = useQuery<{ llm_margin_percentage: number }>({
    queryKey: ["/api/settings/llm-margin"],
  });

  if (!modelInfo) return null;

  const marginPercentage = marginData?.llm_margin_percentage || 30;
  const baseLlmCost = modelInfo.llm;
  const llmCostWithMargin = baseLlmCost * (1 + marginPercentage / 100);
  const totalCost = VOICE_COST + llmCostWithMargin;

  return (
    <div className="mt-2 p-3 bg-secondary/50 rounded-md text-xs">
      <div className="font-medium mb-1">{t('agents.cost.estimatedBreakdown', { margin: marginPercentage })}</div>
      <div className="space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('agents.cost.voiceService')}</span>
          <span>${VOICE_COST.toFixed(3)}/min</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('agents.cost.llm', { model: modelInfo.name })}</span>
          <span>${llmCostWithMargin.toFixed(3)}/min</span>
        </div>
        <div className="h-px bg-border my-2" />
        <div className="flex justify-between font-medium">
          <span>{t('agents.cost.totalCost')}</span>
          <span className="text-primary">${totalCost.toFixed(3)}/min</span>
        </div>
        <div className="mt-2 text-muted-foreground">
          {t('agents.cost.speed')} {modelInfo.speed} • {t('agents.cost.minCall')} ${(totalCost * 60).toFixed(2)}
        </div>
      </div>
    </div>
  );
}

export const CVE_STT_COSTS: Record<string, number> = {
  "deepgram": 0.0125,
  "nova-2": 0.0125,
  "nova-3": 0.015,
  "nova-2-medical": 0.03,
  "sarvam": 0.02,
  "saaras:v3": 0.02,
};

export const CVE_TTS_COSTS: Record<string, number> = {
  "deepgram": 0.015,
  "aura": 0.015,
  "aura-2": 0.02,
  "sarvam": 0.03,
  "bulbul:v3": 0.03,
};

export const CVE_LLM_COSTS: Record<string, number> = {
  "gemini-2.5-flash-lite": 0.002,
  "gemini-2.0-flash-lite": 0.002,
  "gemini-2.0-flash-exp": 0.004,
  "gemini-2.0-flash": 0.004,
  "gemini-2.5-flash": 0.005,
  "gemini-3.5-flash": 0.006,
  "gemini-3.6-flash": 0.007,
  "gemini-2.5-pro": 0.02,
  "gemini-2.0-pro": 0.02,
  "openai/gpt-4o-mini": 0.006,
  "openai/gpt-4o": 0.02,
  "google/gemini-flash-1.5": 0.005,
  "google/gemini-pro-1.5": 0.02,
  "anthropic/claude-3.5-sonnet": 0.06,
  "gpt-4o-mini": 0.006,
  "gpt-4o": 0.02,
  "gpt-4-turbo": 0.04,
  "claude-3-5-sonnet": 0.06,
};

export function CVEEstimatedCost({
  sttProvider,
  sttModel,
  ttsProvider,
  ttsModel,
  llmModel,
}: {
  sttProvider: string;
  sttModel: string;
  ttsProvider: string;
  ttsModel: string;
  llmModel: string;
}) {
  const sttKey = sttModel || sttProvider || "deepgram";
  const sttCost = CVE_STT_COSTS[sttKey] || CVE_STT_COSTS[sttProvider] || 0.0125;

  let ttsKey = ttsModel || ttsProvider || "deepgram";
  if (ttsKey === "aura-2" || ttsKey.startsWith("aura-2-")) {
    ttsKey = "aura-2";
  } else if (ttsKey === "aura" || ttsKey.startsWith("aura-")) {
    ttsKey = "aura";
  }
  const ttsCost = CVE_TTS_COSTS[ttsKey] || CVE_TTS_COSTS[ttsProvider] || 0.015;

  let llmCost = CVE_LLM_COSTS[llmModel];
  if (llmCost === undefined) {
    const lowerModel = (llmModel || "").toLowerCase();
    if (lowerModel.includes("mini") || lowerModel.includes("lite") || lowerModel.includes("flash")) {
      llmCost = 0.005;
    } else if (lowerModel.includes("pro") || lowerModel.includes("sonnet") || lowerModel.includes("4o") || lowerModel.includes("turbo")) {
      llmCost = 0.025;
    } else {
      llmCost = 0.015;
    }
  }

  const totalCost = sttCost + ttsCost + llmCost;
  const inrRate = 95;
  const toInr = (usd: number) => usd * inrRate;

  return (
    <div className="mt-4 p-4 rounded-xl border border-indigo-100 dark:border-indigo-900/50 bg-gradient-to-br from-indigo-50/40 via-purple-50/20 to-transparent dark:from-indigo-950/20 dark:via-purple-950/10 dark:to-transparent text-xs shadow-sm">
      <div className="flex items-center gap-1.5 font-semibold text-indigo-700 dark:text-indigo-300 mb-2.5">
        <Sparkles className="h-3.5 w-3.5" />
        <span>Custom Voice Engine - Cost Breakdown Estimate</span>
      </div>
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground flex items-center gap-1">
            <span>STT ({sttKey})</span>
          </span>
          <span className="font-mono font-medium text-right">
            <span>${sttCost.toFixed(4)}/min</span>
            <span className="text-[10px] text-muted-foreground ml-1.5">(₹{toInr(sttCost).toFixed(2)}/min)</span>
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground flex items-center gap-1">
            <span>TTS ({ttsKey})</span>
          </span>
          <span className="font-mono font-medium text-right">
            <span>${ttsCost.toFixed(4)}/min</span>
            <span className="text-[10px] text-muted-foreground ml-1.5">(₹{toInr(ttsCost).toFixed(2)}/min)</span>
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground flex items-center gap-1">
            <span>LLM Response ({(llmModel || "").split("/").pop()})</span>
          </span>
          <span className="font-mono font-medium text-right">
            <span>${llmCost.toFixed(4)}/min</span>
            <span className="text-[10px] text-muted-foreground ml-1.5">(₹{toInr(llmCost).toFixed(2)}/min)</span>
          </span>
        </div>
        <div className="h-px bg-indigo-100/50 dark:bg-indigo-950/50 my-2" />
        <div className="flex justify-between items-center text-sm font-semibold">
          <span className="text-indigo-900 dark:text-indigo-200">Total Rough Price</span>
          <span className="text-indigo-600 dark:text-indigo-400 font-mono text-right">
            <span>${totalCost.toFixed(4)}/min</span>
            <span className="text-xs text-muted-foreground font-normal ml-2">(₹{toInr(totalCost).toFixed(2)}/min)</span>
          </span>
        </div>
      </div>
    </div>
  );
}
export type AgentFormData = { type: "incoming" | "flow" | "custom_engine"; name: string; voiceTone: string; personality: string; systemPrompt: string; elevenLabsVoiceId: string; language: string; llmModel: string; firstMessage: string; temperature: number; knowledgeBaseIds: string[]; transferNumber: string; transferKeywords: string[]; transferEnabled: boolean; transferPhoneNumber: string; detectLanguageEnabled: boolean; endConversationEnabled: boolean; appointmentBookingEnabled: boolean; messagingEmailEnabled: boolean; messagingWhatsappEnabled: boolean; messagingEmailTemplate: string; messagingWhatsappTemplate: string; messagingWhatsappVariables: string; expressiveMode: boolean; flowId: string; maxDurationSeconds: number; voiceStability: number; voiceSimilarityBoost: number; voiceSpeed: number; turnTimeout: number; telephonyProvider: "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine"; openaiVoice: string; sttProvider: string; sttModel: string; ttsProvider: string; ttsModel: string; sipPhoneNumberId: string; };
