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
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DataPagination, usePagination } from "@/components/ui/data-pagination";
import { Plus, Trash2, Edit, Bot, Sparkles, GitBranch, Mic, FileText } from "lucide-react";
import { useDemoMode } from "@/components/DemoModeBanner";
import Voices from "@/pages/Voices";
import PromptTemplates from "@/pages/PromptTemplates";
import AgentVersionHistory from "@/components/AgentVersionHistory";
import { useToast } from "@/hooks/use-toast";
import AgentCreationWizard from "@/components/AgentCreationWizard";
import { getLanguageLabel } from "@/lib/languages";
import { usePluginStatus } from "@/hooks/use-plugin-status";
import { SipPhoneNumber, Agent, openaiVoices, customVoiceEngineVoices, Voice, KnowledgeBaseItem, MODEL_COSTS, VOICE_COST } from "@/pages/agents/shared";
import { AgentsPageHeader } from "@/pages/agents/AgentsPageHeader";
import { AgentsFilterBar } from "@/pages/agents/AgentsFilterBar";
import { AgentDeleteDialog } from "@/pages/agents/AgentDeleteDialog";
import { KnowledgeUploadDialog } from "@/pages/agents/KnowledgeUploadDialog";
import { DemoVideoDialog } from "@/pages/agents/DemoVideoDialog";
import { AgentFormDialog } from "@/pages/agents/AgentFormDialog";

export { customVoiceEngineVoices } from "@/pages/agents/shared";




export default function Agents() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { isDemoMode } = useDemoMode();
  const [isVideoOpen, setIsVideoOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'agents' | 'templates' | 'voices'>('agents');
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<'all' | 'incoming' | 'flow' | 'cve'>('all');
  const [engineFilter, setEngineFilter] = useState<'all' | 'twilio' | 'plivo' | 'twilio_openai' | 'elevenlabs-sip' | 'openai-sip'>('all');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [knowledgeUploadOpen, setKnowledgeUploadOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  const [formData, setFormData] = useState({
    type: "incoming" as 'incoming' | 'flow' | 'custom_engine',
    name: "",
    voiceTone: "professional",
    personality: "helpful",
    systemPrompt: "",
    elevenLabsVoiceId: "",
    language: "en",
    llmModel: "gpt-4o-mini",
    firstMessage: "Hello! How can I help you today?",
    temperature: 0.5,
    knowledgeBaseIds: [] as string[],
    transferNumber: "",
    transferKeywords: [] as string[],
    // System Tools configuration
    transferEnabled: false,
    transferPhoneNumber: "",
    detectLanguageEnabled: false,
    endConversationEnabled: false,
    appointmentBookingEnabled: false,
    messagingEmailEnabled: false,
    messagingWhatsappEnabled: false,
    messagingEmailTemplate: "",
    messagingWhatsappTemplate: "",
    messagingWhatsappVariables: "",
    expressiveMode: false,
    // Flow Agent specific fields
    flowId: "",
    maxDurationSeconds: 600,
    voiceStability: 0.5,
    voiceSimilarityBoost: 0.85,
    voiceSpeed: 1.0,
    turnTimeout: 1.5,
    // Telephony Provider selection (Twilio/ElevenLabs, Plivo/OpenAI, Twilio/OpenAI, or SIP engines)
    telephonyProvider: "twilio" as "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine",
    openaiVoice: "aura-asteria-en",
    sttProvider: "deepgram",
    sttModel: "",
    ttsProvider: "deepgram",
    ttsModel: "",
    // SIP phone number selection (for SIP engines)
    sipPhoneNumberId: "",
  });
  const [knowledgeData, setKnowledgeData] = useState({
    title: "",
    type: "document",
    content: "",
  });

  // Animation state for success/failure feedback
  const [animationState, setAnimationState] = useState<'idle' | 'success' | 'error'>('idle');

  // Check if SIP plugin is enabled and which engines are allowed
  const { isSipPluginEnabled, sipEnginesAllowed, isCustomVoiceEngineEnabled } = usePluginStatus();
  const isElevenLabsSipAllowed = isSipPluginEnabled && sipEnginesAllowed.includes("elevenlabs-sip");
  const isOpenAISipAllowed = isSipPluginEnabled && sipEnginesAllowed.includes("openai-sip");

  const { data: agents = [], isLoading: agentsLoading } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
  });
  const combinedAgents = agents;
  const combinedLoading = agentsLoading;

  // Fetch metrics data
  const { data: metricsData } = useQuery<{ success: boolean; data: any }>({
    queryKey: ["/api/agents/metrics"],
    // Refresh less frequently to avoid DB strain
    staleTime: 60000,
  });

  const { data: voices = [] } = useQuery<Voice[]>({
    queryKey: ["/api/elevenlabs/voices"],
  });

  // Voice lookup helper - only uses account voices
  const getVoiceName = useMemo(() => {
    const voiceMap = new Map(voices.map(v => [v.voice_id, v.name]));
    return (voiceId: string | null): string | null => {
      if (!voiceId) return null;
      return voiceMap.get(voiceId) || null;
    };
  }, [voices]);

  const { data: knowledgeBase = [] } = useQuery<KnowledgeBaseItem[]>({
    queryKey: ["/api/knowledge-base"],
  });

  // Fetch available LLM models for current user (filtered by plan tier)
  const { data: availableLLMModels = [] } = useQuery<Array<{
    id: string;
    modelId: string;
    name: string;
    provider: string;
    tier: 'free' | 'pro';
    isActive: boolean;
  }>>({
    queryKey: ["/api/llm-models/available"],
  });

  const { data: flows = [] } = useQuery<Array<{ id: string; name: string; description: string }>>({
    queryKey: ["/api/flow-automation/flows"],
  });

  // Fetch voice engine settings to check if Plivo+OpenAI or Twilio+OpenAI is enabled
  const { data: voiceEngineSettings } = useQuery<{ plivo_openai_engine_enabled: boolean; twilio_openai_engine_enabled: boolean; default_tts_model?: string }>({
    queryKey: ["/api/settings/voice-engine"],
    staleTime: 60000,
  });

  const isPlivoEnabled = voiceEngineSettings?.plivo_openai_engine_enabled ?? false;
  const isTwilioOpenaiEnabled = voiceEngineSettings?.twilio_openai_engine_enabled ?? false;
  const isV3TtsModel = (voiceEngineSettings?.default_tts_model || '').includes('v3');

  // Fetch CVE admin settings for active TTS provider and OpenRouter models
  const { data: cveSettings } = useQuery<{ success: boolean; data: { stt: { activeProvider: string, allowedProviders?: string[], deepgramAllowedModels?: string[], sarvamAllowedModels?: string[] }, tts: { activeProvider: string, allowedProviders?: string[], deepgramAllowedModels?: string[], sarvamAllowedModels?: string[] }; llm: { activeProvider?: string; defaultModel: string; allowedModels?: string[] } } }>({
    queryKey: ["/api/voice-engine/admin/provider-keys"],
    staleTime: 30000,
    enabled: isCustomVoiceEngineEnabled,
  });
  const activeTtsProvider = cveSettings?.data?.tts?.activeProvider || "deepgram";
  const activeSttProvider = cveSettings?.data?.stt?.activeProvider || "deepgram";
  const activeLlmProvider = cveSettings?.data?.llm?.activeProvider || "openrouter";
  const allowedTtsProviders = cveSettings?.data?.tts?.allowedProviders || [activeTtsProvider];
  const allowedSttProviders = cveSettings?.data?.stt?.allowedProviders || [activeSttProvider];

  const currentSttAllowedModels = formData.sttProvider === 'deepgram'
    ? (cveSettings?.data?.stt?.deepgramAllowedModels || ['nova-2', 'nova-2-phonecall'])
    : (cveSettings?.data?.stt?.sarvamAllowedModels || ['saaras:v3']);

  const sarvamSupportedLanguages = ['en', 'hi', 'bn', 'ta', 'te', 'kn', 'ml', 'mr', 'gu', 'pa', 'or', 'od'];

  const rawDeepgramAllowed = cveSettings?.data?.tts?.deepgramAllowedModels || ['aura-2', 'aura'];
  const mappedDeepgramAllowed = Array.from(new Set(rawDeepgramAllowed.map(m => m.startsWith('aura-2') ? 'aura-2' : 'aura')));

  const currentTtsAllowedModels = (formData.ttsProvider === 'deepgram'
    ? mappedDeepgramAllowed
    : (cveSettings?.data?.tts?.sarvamAllowedModels || ['bulbul:v3', 'bulbul:v2']))
    .filter(m => {
      if (!formData.language) return true;
      if (formData.ttsProvider === 'deepgram') {
        if (formData.language.toLowerCase() !== 'en') {
          return m === 'aura-2';
        }
        return true;
      }
      if (formData.ttsProvider === 'sarvam') {
        return sarvamSupportedLanguages.includes(formData.language.toLowerCase());
      }
      return true;
    });

  const { data: orModelsData, isLoading: isOrModelsLoading } = useQuery<{
    success: boolean;
    data: { id: string; name: string; context_length: number }[];
  }>({
    queryKey: ["/api/voice-engine/admin/provider-keys/openrouter-models"],
    staleTime: 5 * 60 * 1000,
    enabled: isCustomVoiceEngineEnabled,
  });
  const allOrModels = orModelsData?.data ?? [];
  const allowedModels = cveSettings?.data?.llm?.allowedModels || [];
  const orModels = allowedModels.length > 0
    ? allOrModels.filter(m => allowedModels.includes(m.id))
    : allOrModels;

  const [orSearch, setOrSearch] = useState("");



  // Fetch SIP phone numbers when SIP plugin is enabled
  const { data: sipPhoneNumbersResponse } = useQuery<{ success: boolean; data: SipPhoneNumber[] }>({
    queryKey: ["/api/sip/phone-numbers"],
    enabled: isSipPluginEnabled,
  });
  const sipPhoneNumbers = sipPhoneNumbersResponse?.data || [];

  const hasAlternateEngines = isPlivoEnabled || isTwilioOpenaiEnabled || isElevenLabsSipAllowed || isOpenAISipAllowed || isCustomVoiceEngineEnabled;

  const { data: emailTemplatesResponse } = useQuery<{ success: boolean; data: Array<{ id: string; name: string }> }>({
    queryKey: ["/api/messaging/email-templates"],
    staleTime: 60000,
  });
  const emailTemplates = emailTemplatesResponse?.data || [];
  const hasEmailTemplates = emailTemplates.length > 0;

  const { data: whatswaySettingsResponse } = useQuery<{ success: boolean; data: any }>({
    queryKey: ["/api/messaging/whatsway/settings"],
    staleTime: 60000,
  });
  const { data: metaWhatsAppSettingsResponse } = useQuery<{ success: boolean; data: any }>({
    queryKey: ["/api/messaging/meta-whatsapp/settings"],
    staleTime: 60000,
  });
  const isWhatsAppActive = !!(whatswaySettingsResponse?.data?.isActive || metaWhatsAppSettingsResponse?.data?.isActive);

  const { data: whatswayTemplatesResponse } = useQuery<{ success: boolean; data: Array<{ name: string; id?: string; components?: any[] }> }>({
    queryKey: ["/api/messaging/whatsway/templates"],
    enabled: !!(whatswaySettingsResponse?.data?.isActive),
    staleTime: 60000,
  });
  const { data: metaTemplatesResponse } = useQuery<{ success: boolean; data: Array<{ name: string; id?: string; components?: any[] }> }>({
    queryKey: ["/api/messaging/meta-whatsapp/templates"],
    enabled: !!(metaWhatsAppSettingsResponse?.data?.isActive),
    staleTime: 60000,
  });
  const whatsappTemplates = whatswayTemplatesResponse?.data || metaTemplatesResponse?.data || [];

  const getWhatsAppTemplateVariables = (templateName: string): number[] => {
    const template = whatsappTemplates.find(t => t.name === templateName);
    if (!template?.components) return [];
    const bodyComponent = template.components.find((c: any) => c.type === 'BODY');
    if (!bodyComponent?.text) return [];
    const matches = bodyComponent.text.match(/\{\{(\d+)\}\}/g) || [];
    return matches.map((m: string) => parseInt(m.replace(/[{}]/g, '')));
  };

  const getWhatsAppTemplateHeaderInfo = (templateName: string): { format: string; hasVariable: boolean; text?: string } | null => {
    const template = whatsappTemplates.find(t => t.name === templateName);
    if (!template?.components) return null;
    const headerComp = template.components.find((c: any) => c.type === 'HEADER');
    if (!headerComp) return null;
    const format = (headerComp.format || '').toUpperCase();
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
      return { format, hasVariable: true, text: headerComp.text };
    }
    if (format === 'TEXT' && headerComp.text) {
      const matches = headerComp.text.match(/\{\{\d+\}\}/g) || [];
      if (matches.length > 0) return { format, hasVariable: true, text: headerComp.text };
    }
    return null;
  };

  const getWhatsAppTemplateButtonVariables = (templateName: string): Array<{ index: number; label: string; url: string }> => {
    const template = whatsappTemplates.find(t => t.name === templateName);
    if (!template?.components) return [];
    const buttonsComponent = template.components.find((c: any) => c.type === 'BUTTONS' || c.type === 'buttons');
    if (!buttonsComponent?.buttons || !Array.isArray(buttonsComponent.buttons)) return [];
    const result: Array<{ index: number; label: string; url: string }> = [];
    buttonsComponent.buttons.forEach((btn: any, index: number) => {
      if (btn.type === 'URL' && btn.url && btn.url.includes('{{')) {
        result.push({ index, label: btn.text || `Button ${index + 1}`, url: btn.url });
      }
    });
    return result;
  };

  const parseWhatsAppVariables = (varsJson: string): Record<string, { mode: 'fixed' | 'collect'; value: string; componentType?: string }> => {
    try {
      if (!varsJson) return {};
      const parsed = JSON.parse(varsJson);
      const result: Record<string, { mode: 'fixed' | 'collect'; value: string; componentType?: string }> = {};
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val === 'string') {
          result[key] = { mode: 'collect', value: val };
        } else if (val && typeof val === 'object' && 'mode' in (val as any)) {
          result[key] = val as { mode: 'fixed' | 'collect'; value: string; componentType?: string };
        }
      }
      return result;
    } catch {
      return {};
    }
  };

  // Fetch OpenAI Realtime models (for Plivo+OpenAI or Twilio+OpenAI engine)
  const { data: openaiModelsData } = useQuery<{
    tier: 'free' | 'pro';
    models: string[];
    description: string;
    allTiers: Record<string, { models: string[]; description: string }>;
  }>({
    queryKey: ["/api/plivo/openai/models"],
    enabled: isPlivoEnabled || isTwilioOpenaiEnabled || formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai",
    staleTime: 60000,
  });

  // OpenAI Realtime models with display info
  const openaiRealtimeModels = useMemo(() => {
    if (!openaiModelsData?.models) return [];

    const modelInfo: Record<string, { name: string; tier: 'free' | 'pro'; description: string }> = {
      'gpt-realtime-2': { name: 'GPT Realtime 2', tier: 'pro', description: 'Advanced GPT-5-class reasoning realtime voice model' },
      'gpt-realtime-translate': { name: 'GPT Realtime Translate', tier: 'pro', description: 'Live translation model from 70+ languages' },
      'gpt-realtime-whisper': { name: 'GPT Realtime Whisper', tier: 'pro', description: 'Streaming live speech-to-text transcription model' },
      'gpt-realtime-1.5': { name: 'GPT Realtime 1.5', tier: 'pro', description: 'The best voice model for audio in, audio out' },
      'gpt-realtime': { name: 'GPT Realtime', tier: 'pro', description: 'Realtime text and audio inputs and outputs' },
      'gpt-realtime-mini': { name: 'GPT Realtime Mini', tier: 'free', description: 'A cost-efficient version of GPT Realtime' },
      'gpt-4o-realtime-preview': { name: 'GPT-4o Realtime Preview', tier: 'pro', description: 'Preview model for projects without GA access' },
      'gpt-4o-mini-realtime-preview': { name: 'GPT-4o Mini Realtime Preview', tier: 'free', description: 'Preview mini model for projects without GA access' },
    };

    return openaiModelsData.models.map(modelId => {
      const info = modelInfo[modelId] || { name: modelId, tier: 'free' as const, description: 'OpenAI Realtime model' };
      return {
        id: modelId,
        modelId,
        name: info.name,
        tier: info.tier,
        description: info.description,
      };
    });
  }, [openaiModelsData]);

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      if (data.telephonyProvider === "custom-voice-engine") {
        const payload = {
          name: data.name,
          description: "",
          systemPrompt: data.systemPrompt,
          firstMessage: data.firstMessage || "Hello! How can I help you today?",
          language: data.language || "en",
          llmModel: data.llmModel || "openai/gpt-4o-mini",
          temperature: data.temperature ?? 0.7,
          maxTokens: 500,
          ttsVoice: data.openaiVoice || "aura-asteria-en",
          ttsProvider: data.ttsProvider || "deepgram",
          sttProvider: data.sttProvider || "deepgram",
          sttModel: data.sttModel || "",
          ttsModel: data.ttsModel || "",
          interruptible: true,
          silenceTimeoutMs: 5000,
          maxDurationSeconds: data.maxDurationSeconds ?? 600,
          endCallOnSilence: false,
          businessRules: [],
          enableMemory: true,
          memoryRetentionDays: 90,
          detectLanguageEnabled: data.detectLanguageEnabled || false,
          knowledgeBaseIds: data.knowledgeBaseIds || [],
          appointmentBookingEnabled: data.appointmentBookingEnabled || false,
          endConversationEnabled: data.endConversationEnabled || false,
          transferEnabled: data.transferEnabled || false,
          transferPhoneNumber: data.transferPhoneNumber || "",
          messagingEmailEnabled: data.messagingEmailEnabled || false,
          messagingWhatsappEnabled: data.messagingWhatsappEnabled || false,
          messagingEmailTemplate: data.messagingEmailTemplate || "",
          messagingWhatsappTemplate: data.messagingWhatsappTemplate || "",
        };
        const res = await apiRequest("POST", "/api/voice-engine/agents", payload);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/agents", data);
      return res.json();
    },
    onSuccess: () => {
      // Trigger success animation
      setAnimationState('success');
      setTimeout(() => {
        setAnimationState('idle');
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/voice-engine/agents"] });
        setCreateDialogOpen(false);
        resetForm();
      }, 1500);
      toast({ title: t('agents.toast.created') });
    },
    onError: (error: any) => {
      // Trigger error animation
      setAnimationState('error');
      setTimeout(() => setAnimationState('idle'), 600);
      toast({
        title: t('agents.toast.createFailed'),
        description: error.message || t('agents.toast.tryAgain'),
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<typeof formData> }) => {
      const isCve = editingAgent?.telephonyProvider === "custom-voice-engine";
      if (isCve) {
        const payload = {
          name: data.name,
          description: (editingAgent as any)?.description || "",
          systemPrompt: data.systemPrompt,
          firstMessage: data.firstMessage || "Hello! How can I help you today?",
          language: data.language || "en",
          llmModel: data.llmModel || "openai/gpt-4o-mini",
          temperature: data.temperature ?? 0.7,
          maxTokens: 500,
          ttsVoice: data.openaiVoice || "aura-asteria-en",
          ttsProvider: data.ttsProvider || "deepgram",
          sttProvider: data.sttProvider || "deepgram",
          sttModel: data.sttModel || "",
          ttsModel: data.ttsModel || "",
          interruptible: true,
          silenceTimeoutMs: 5000,
          maxDurationSeconds: data.maxDurationSeconds ?? 600,
          endCallOnSilence: false,
          businessRules: [],
          enableMemory: true,
          memoryRetentionDays: 90,
          isActive: true,
          detectLanguageEnabled: data.detectLanguageEnabled || false,
          knowledgeBaseIds: data.knowledgeBaseIds || [],
          appointmentBookingEnabled: data.appointmentBookingEnabled || false,
          endConversationEnabled: data.endConversationEnabled || false,
          transferEnabled: data.transferEnabled || false,
          transferPhoneNumber: data.transferPhoneNumber || "",
          messagingEmailEnabled: data.messagingEmailEnabled || false,
          messagingWhatsappEnabled: data.messagingWhatsappEnabled || false,
          messagingEmailTemplate: data.messagingEmailTemplate || "",
          messagingWhatsappTemplate: data.messagingWhatsappTemplate || "",
        };
        const res = await apiRequest("PUT", `/api/voice-engine/agents/${id}`, payload);
        return res.json();
      }
      const res = await apiRequest("PATCH", `/api/agents/${id}`, data);
      return res.json();
    },
    onSuccess: (data) => {
      // Trigger success animation
      setAnimationState('success');
      setTimeout(() => {
        setAnimationState('idle');
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/voice-engine/agents"] });
        setEditingAgent(null);
        resetForm();
      }, 1500);

      if (data.warning) {
        toast({
          title: t('agents.toast.updated'),
          description: data.warning,
        });
      } else {
        toast({ title: t('agents.toast.updated') });
      }
    },
    onError: (error: any) => {
      // Trigger error animation
      setAnimationState('error');
      setTimeout(() => setAnimationState('idle'), 600);
      toast({
        title: t('agents.toast.updateFailed'),
        description: error.message || t('agents.toast.tryAgain'),
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const isCve = deletingAgent?.telephonyProvider === "custom-voice-engine";
      const endpoint = isCve ? `/api/voice-engine/agents/${id}` : `/api/agents/${id}`;
      const res = await apiRequest("DELETE", endpoint);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/voice-engine/agents"] });
      setDeletingAgent(null);
      toast({ title: t('agents.toast.deleted') });
    },
    onError: (error: any) => {
      toast({
        title: t('agents.toast.deleteFailed'),
        description: error.message || t('agents.toast.tryAgain'),
        variant: "destructive",
      });
    },
  });

  const uploadKnowledgeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/knowledge-base", knowledgeData);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-base"] });
      setKnowledgeUploadOpen(false);
      setKnowledgeData({ title: "", type: "document", content: "" });
      toast({ title: t('agents.toast.knowledgeUploaded') });
    },
    onError: (error: any) => {
      toast({
        title: t('agents.toast.knowledgeUploadFailed'),
        description: error.message || t('agents.toast.tryAgain'),
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setFormData({
      type: "incoming" as 'incoming' | 'flow' | 'custom_engine',
      name: "",
      voiceTone: "professional",
      personality: "helpful",
      systemPrompt: "",
      elevenLabsVoiceId: "",
      language: "en",
      llmModel: "gpt-4o-mini",
      firstMessage: "Hello! How can I help you today?",
      temperature: 0.5,
      knowledgeBaseIds: [],
      transferNumber: "",
      transferKeywords: [],
      // System Tools configuration
      transferEnabled: false,
      transferPhoneNumber: "",
      detectLanguageEnabled: false,
      endConversationEnabled: false,
      appointmentBookingEnabled: false,
      messagingEmailEnabled: false,
      messagingWhatsappEnabled: false,
      messagingEmailTemplate: "",
      messagingWhatsappTemplate: "",
      messagingWhatsappVariables: "",
      expressiveMode: false,
      flowId: "",
      maxDurationSeconds: 600,
      voiceStability: 0.5,
      voiceSimilarityBoost: 0.85,
      voiceSpeed: 1.0,
      turnTimeout: 1.5,
      // Telephony Provider selection
      telephonyProvider: "twilio" as "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine",
      openaiVoice: "alloy",
      sipPhoneNumberId: "",
      sttProvider: "deepgram",
      sttModel: "",
      ttsProvider: "deepgram",
      ttsModel: "",
    });
  };

  const handleCreate = () => {
    if (!formData.name) {
      toast({
        title: t('agents.toast.missingFields'),
        description: t('agents.toast.pleaseEnterName'),
        variant: "destructive",
      });
      return;
    }

    // Incoming Agent validation
    if (formData.type === 'incoming') {
      // Voice validation depends on telephony provider
      const isOpenAIVoiceOrCve = formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip" || formData.telephonyProvider === "custom-voice-engine";
      const hasValidVoice = isOpenAIVoiceOrCve
        ? !!formData.openaiVoice
        : !!formData.elevenLabsVoiceId;
      // Note: SIP phone number selection moved to campaign level
      if (!hasValidVoice) {
        toast({
          title: t('agents.toast.missingFields'),
          description: t('agents.toast.pleaseSelectVoice'),
          variant: "destructive",
        });
        return;
      }
      if (!formData.systemPrompt) {
        toast({
          title: t('agents.toast.missingFields'),
          description: t('agents.toast.systemPromptRequired'),
          variant: "destructive",
        });
        return;
      }
      // Validate call transfer configuration
      if (formData.transferEnabled && !formData.transferPhoneNumber.trim()) {
        toast({
          title: t('agents.toast.missingTransferPhone'),
          description: t('agents.toast.transferPhoneRequired'),
          variant: "destructive",
        });
        return;
      }
      if (formData.messagingEmailEnabled && !formData.messagingEmailTemplate) {
        toast({
          title: t('agents.toast.missingFields'),
          description: "Please select an email template when email sending is enabled.",
          variant: "destructive",
        });
        return;
      }
      if (formData.messagingWhatsappEnabled && !formData.messagingWhatsappTemplate) {
        toast({
          title: t('agents.toast.missingFields'),
          description: "Please select a WhatsApp template when WhatsApp sending is enabled.",
          variant: "destructive",
        });
        return;
      }
    }

    // Flow Agent validation
    if (formData.type === 'flow') {
      if (!formData.flowId) {
        toast({
          title: t('agents.toast.missingFields'),
          description: t('agents.toast.flowRequired'),
          variant: "destructive",
        });
        return;
      }
      // Voice validation depends on telephony provider for flow agents
      const isOpenAIVoiceOrCveFlow = formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip" || formData.telephonyProvider === "custom-voice-engine";
      const hasValidVoice = isOpenAIVoiceOrCveFlow
        ? !!formData.openaiVoice
        : !!formData.elevenLabsVoiceId;
      // Note: SIP phone number selection moved to campaign level
      if (!hasValidVoice) {
        toast({
          title: t('agents.toast.missingFields'),
          description: t('agents.toast.pleaseSelectVoice'),
          variant: "destructive",
        });
        return;
      }
    }

    createMutation.mutate(formData);
  };

  const handleEdit = (agent: Agent) => {
    setEditingAgent(agent);
    setFormData({
      type: agent.telephonyProvider === 'custom-voice-engine' ? 'custom_engine' : (agent.type || "incoming"),
      name: agent.name,
      voiceTone: agent.voiceTone || "professional",
      personality: agent.personality || "helpful",
      systemPrompt: agent.systemPrompt || "",
      elevenLabsVoiceId: agent.elevenLabsVoiceId || "",
      language: agent.language || "en",
      llmModel: agent.llmModel || "gpt-4o-mini",
      firstMessage: agent.firstMessage || "Hello! How can I help you today?",
      temperature: agent.temperature ?? 0.5,
      knowledgeBaseIds: agent.knowledgeBaseIds || (agent as any).knowledge_base_ids || [],
      transferNumber: agent.config?.transferRules?.number || "",
      transferKeywords: agent.config?.transferRules?.keywords || [],
      // System Tools configuration
      transferEnabled: agent.transferEnabled ?? (agent as any).transfer_enabled ?? false,
      transferPhoneNumber: agent.transferPhoneNumber || (agent as any).transfer_phone_number || "",
      detectLanguageEnabled: agent.detectLanguageEnabled ?? (agent as any).detect_language_enabled ?? false,
      endConversationEnabled: agent.endConversationEnabled ?? (agent as any).end_conversation_enabled ?? false,
      appointmentBookingEnabled: agent.appointmentBookingEnabled ?? (agent as any).appointment_booking_enabled ?? false,
      messagingEmailEnabled: (agent as any).messagingEmailEnabled ?? (agent as any).messaging_email_enabled ?? false,
      messagingWhatsappEnabled: (agent as any).messagingWhatsappEnabled ?? (agent as any).messaging_whatsapp_enabled ?? false,
      messagingEmailTemplate: (agent as any).messagingEmailTemplate || (agent as any).messaging_email_template || "",
      messagingWhatsappTemplate: (agent as any).messagingWhatsappTemplate || (agent as any).messaging_whatsapp_template || "",
      messagingWhatsappVariables: (agent as any).messagingWhatsappVariables || "",
      expressiveMode: agent.expressiveMode ?? false,
      flowId: agent.flowId || "",
      maxDurationSeconds: agent.maxDurationSeconds ?? 600,
      voiceStability: agent.voiceStability ?? 0.5,
      voiceSimilarityBoost: agent.voiceSimilarityBoost ?? 0.85,
      voiceSpeed: agent.voiceSpeed ?? 1.0,
      turnTimeout: agent.turnTimeout ?? 1.5,
      // Telephony Provider selection
      telephonyProvider: (agent.telephonyProvider || "twilio") as "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine",
      openaiVoice: agent.openaiVoice || (agent as any).tts_voice || "alloy",
      sttProvider: (agent as any).stt_provider || (agent as any).config?.sttProvider || "deepgram",
      ttsProvider: (agent as any).tts_provider || (agent as any).config?.ttsProvider || "deepgram",
      sttModel: (agent as any).stt_model || (agent as any).config?.sttModel || (((agent as any).stt_provider || (agent as any).config?.sttProvider) === 'sarvam' ? (currentSttAllowedModels[0] || 'saaras:v3') : ""),
      ttsModel: (agent as any).tts_model || (agent as any).config?.ttsModel || (((agent as any).tts_provider || (agent as any).config?.ttsProvider) === 'sarvam' ? (currentTtsAllowedModels[0] || 'bulbul:v3') : ""),
      sipPhoneNumberId: (agent as any).sipPhoneNumberId || "",
    });
  };

  const handleUpdate = () => {
    if (!editingAgent) return;

    // Validate call transfer configuration for incoming agents
    if (formData.type === 'incoming' && formData.transferEnabled && !formData.transferPhoneNumber.trim()) {
      toast({
        title: t('agents.toast.missingTransferPhone'),
        description: t('agents.toast.transferPhoneRequired'),
        variant: "destructive",
      });
      return;
    }
    if (formData.type === 'incoming' && formData.messagingEmailEnabled && !formData.messagingEmailTemplate) {
      toast({
        title: t('agents.toast.missingFields'),
        description: "Please select an email template when email sending is enabled.",
        variant: "destructive",
      });
      return;
    }
    if (formData.type === 'incoming' && formData.messagingWhatsappEnabled && !formData.messagingWhatsappTemplate) {
      toast({
        title: t('agents.toast.missingFields'),
        description: "Please select a WhatsApp template when WhatsApp sending is enabled.",
        variant: "destructive",
      });
      return;
    }

    updateMutation.mutate({ id: editingAgent.id, data: formData });
  };

  const filteredAgents = combinedAgents
    .filter((agent) => {
      // Filter by type
      if (typeFilter === 'cve') {
        if (agent.telephonyProvider !== 'custom-voice-engine') {
          return false;
        }
      } else if (typeFilter === 'incoming') {
        if (agent.type !== 'incoming' || agent.telephonyProvider === 'custom-voice-engine') {
          return false;
        }
      } else if (typeFilter === 'flow') {
        if (agent.type !== 'flow' || agent.telephonyProvider === 'custom-voice-engine') {
          return false;
        }
      }
      // Filter by engine/telephony provider
      if (engineFilter !== 'all') {
        const agentProvider = agent.telephonyProvider || 'twilio';
        if (agentProvider !== engineFilter) {
          return false;
        }
      }
      // Filter by search query
      return agent.name.toLowerCase().includes(searchQuery.toLowerCase());
    });

  // Pagination for agents grid
  const {
    currentPage,
    totalPages,
    totalItems,
    itemsPerPage,
    paginatedItems,
    handlePageChange,
    handleItemsPerPageChange,
  } = usePagination(filteredAgents, 9);

  const cveCount = combinedAgents.filter(a => a.telephonyProvider === 'custom-voice-engine').length;
  const incomingCount = combinedAgents.filter(a => a.type === 'incoming' && a.telephonyProvider !== 'custom-voice-engine').length;
  const flowCount = combinedAgents.filter(a => a.type === 'flow' && a.telephonyProvider !== 'custom-voice-engine').length;

  return (
    <div className="space-y-6">
      {/* Tab Navigation */}
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'agents' | 'templates' | 'voices')} className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-3 mb-6">
          <TabsTrigger value="agents" className="flex items-center gap-2" data-testid="tab-agents">
            <Bot className="h-4 w-4" />
            {t('nav.agents')}
          </TabsTrigger>
          <TabsTrigger value="templates" className="flex items-center gap-2" data-testid="tab-templates">
            <FileText className="h-4 w-4" />
            {t('nav.promptTemplates')}
          </TabsTrigger>
          <TabsTrigger value="voices" className="flex items-center gap-2" data-testid="tab-voices">
            <Mic className="h-4 w-4" />
            {t('nav.voices')}
          </TabsTrigger>
        </TabsList>

        {/* Prompt Templates Tab */}
        <TabsContent value="templates" className="mt-0">
          <PromptTemplates />
        </TabsContent>

        {/* Voices Tab */}
        <TabsContent value="voices" className="mt-0">
          <Voices />
        </TabsContent>

        {/* Agents Tab */}
        <TabsContent value="agents" className="mt-0 space-y-6">
          {/* Page Header with Light Gradient */}
          <AgentsPageHeader
            t={t}
            isDemoMode={isDemoMode}
            setIsVideoOpen={setIsVideoOpen}
            setWizardOpen={setWizardOpen}
            setCreateDialogOpen={setCreateDialogOpen}
            createDialogOpen={createDialogOpen}
            combinedAgents={combinedAgents}
            incomingCount={incomingCount}
            flowCount={flowCount}
          />

          {/* Filters and Search Row */}
          <AgentsFilterBar
            typeFilter={typeFilter}
            setTypeFilter={setTypeFilter}
            t={t}
            agents={agents}
            incomingCount={incomingCount}
            flowCount={flowCount}
            isCustomVoiceEngineEnabled={isCustomVoiceEngineEnabled}
            cveCount={cveCount}
            hasAlternateEngines={hasAlternateEngines}
            engineFilter={engineFilter}
            setEngineFilter={setEngineFilter}
            isTwilioOpenaiEnabled={isTwilioOpenaiEnabled}
            isPlivoEnabled={isPlivoEnabled}
            isElevenLabsSipAllowed={isElevenLabsSipAllowed}
            isOpenAISipAllowed={isOpenAISipAllowed}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
          />

          {combinedLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="p-6 animate-pulse">
                  <div className="h-6 bg-muted rounded w-3/4 mb-4" />
                  <div className="h-4 bg-muted rounded w-full mb-2" />
                  <div className="h-4 bg-muted rounded w-2/3" />
                </Card>
              ))}
            </div>
          ) : filteredAgents.length === 0 ? (
            <div className="relative overflow-hidden rounded-2xl border border-dashed border-muted-foreground/25 p-12 text-center">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-violet-500/5" />
              <div className="relative">
                <div className="h-16 w-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 flex items-center justify-center">
                  <Bot className="h-8 w-8 text-blue-600 dark:text-blue-400" />
                </div>
                <h3 className="text-xl font-semibold mb-2">
                  {searchQuery ? t('agents.noAgentsFound') : t('agents.noAgents')}
                </h3>
                <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                  {searchQuery
                    ? t('agents.noMatchingSearch')
                    : t('agents.getStarted')}
                </p>
                {!searchQuery && (
                  <Button
                    onClick={() => setCreateDialogOpen(true)}
                    disabled={createDialogOpen}
                    className="bg-gradient-to-r from-blue-600 to-violet-600 text-white"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    {t('agents.createFirstAgent')}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginatedItems.map((agent) => {
                  const isCve = agent.telephonyProvider === 'custom-voice-engine';
                  const isOpenAIProvider = agent.telephonyProvider === "plivo" || agent.telephonyProvider === "twilio_openai" || agent.telephonyProvider === "openai-sip";
                  const cveVoiceObj = isCve ? customVoiceEngineVoices.find(v => v.value === agent.openaiVoice) : null;
                  const voiceName = isCve
                    ? cveVoiceObj?.label || agent.openaiVoice || null
                    : isOpenAIProvider
                      ? openaiVoices.find(v => v.value === agent.openaiVoice)?.label || null
                      : getVoiceName(agent.elevenLabsVoiceId);
                  const languageName = agent.language ? t(`agents.languages.${agent.language}`, { defaultValue: getLanguageLabel(agent.language) }) : t('agents.languages.en');

                  const isIncoming = agent.type === 'incoming' && !isCve;
                  const cardGradient = isCve
                    ? 'from-orange-500/5 via-transparent to-amber-500/5 dark:from-orange-500/10 dark:to-amber-500/10'
                    : isIncoming
                      ? 'from-emerald-500/5 via-transparent to-brand/5 dark:from-emerald-500/10 dark:to-brand/10'
                      : 'from-violet-500/5 via-transparent to-indigo-500/5 dark:from-violet-500/10 dark:to-indigo-500/10';
                  const iconBg = isCve
                    ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400'
                    : isIncoming
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-violet-500/10 text-violet-600 dark:text-violet-400';
                  const borderColor = isCve
                    ? 'border-orange-500/20 hover:border-orange-500/40'
                    : isIncoming
                      ? 'border-emerald-500/20 hover:border-emerald-500/40'
                      : 'border-violet-500/20 hover:border-violet-500/40';

                  return (
                    <Card
                      key={agent.id}
                      className={`relative overflow-hidden border ${borderColor} transition-all duration-200 hover-elevate group`}
                      data-testid={`card-agent-${agent.id}`}
                    >
                      <div className={`absolute inset-0 bg-gradient-to-br ${cardGradient}`} />
                      <div className="relative p-5">
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
                              {isCve ? <Bot className="h-5 w-5" /> : isIncoming ? <Sparkles className="h-5 w-5" /> : <GitBranch className="h-5 w-5" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <h3 className="font-semibold truncate" data-testid="text-agent-name">
                                {agent.name}
                              </h3>
                              <Badge
                                variant="outline"
                                className={`mt-1 text-xs ${isCve
                                  ? 'border-orange-500/50 text-orange-700 dark:text-orange-300 bg-orange-500/10'
                                  : isIncoming
                                    ? 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10'
                                    : 'border-violet-500/50 text-violet-700 dark:text-violet-300 bg-violet-500/10'}`}
                                data-testid={`badge-agent-type-${agent.type}`}
                              >
                                {isCve ? "Custom Voice" : isIncoming ? t('agents.type.incoming') : t('agents.type.flow')}
                              </Badge>
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <AgentVersionHistory
                              agentId={agent.id}
                              agentName={agent.name}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleEdit(agent)}
                              data-testid="button-edit-agent"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => setDeletingAgent(agent)}
                              data-testid="button-delete-agent"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-2 text-sm">
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Mic className="h-3.5 w-3.5" />
                            <span data-testid="text-agent-voice">{voiceName || t('agents.voiceNotSet')}</span>
                            <span className="text-muted-foreground/50">•</span>
                            <span data-testid="text-agent-language">{languageName}</span>
                          </div>
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <span className="capitalize">{isCve ? (cveVoiceObj?.description || 'Custom Voice') : agent.voiceTone}</span>
                            <span className="text-muted-foreground/50">•</span>
                            <span className="capitalize">{isCve ? (cveVoiceObj?.provider || 'Voice Engine') : agent.personality}</span>
                          </div>
                          {agent.config?.model && MODEL_COSTS[agent.config.model] && (
                            <div className={`flex items-center gap-2 text-xs font-medium ${isCve ? 'text-orange-600 dark:text-orange-400' : isIncoming ? 'text-emerald-600 dark:text-emerald-400' : 'text-violet-600 dark:text-violet-400'}`}>
                              <span>≈ ${(VOICE_COST + MODEL_COSTS[agent.config.model].llm).toFixed(3)}/min</span>
                              <span className="opacity-50">•</span>
                              <span>{MODEL_COSTS[agent.config.model].speed}</span>
                            </div>
                          )}
                        </div>

                        {agent.systemPrompt && (
                          <p className="mt-3 text-xs text-muted-foreground line-clamp-2 border-t border-border/50 pt-3">
                            {agent.systemPrompt}
                          </p>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>

              {/* Pagination */}
              <DataPagination
                currentPage={currentPage}
                totalPages={totalPages}
                totalItems={totalItems}
                itemsPerPage={itemsPerPage}
                onPageChange={handlePageChange}
                onItemsPerPageChange={handleItemsPerPageChange}
                itemsPerPageOptions={[9, 18, 27, 45]}
                data-testid="agents-pagination"
              />
            </div>
          )}

          <AgentFormDialog
            createDialogOpen={createDialogOpen}
            editingAgent={editingAgent}
            setCreateDialogOpen={setCreateDialogOpen}
            setEditingAgent={setEditingAgent}
            resetForm={resetForm}
            animationState={animationState}
            t={t}
            isCustomVoiceEngineEnabled={isCustomVoiceEngineEnabled}
            formData={formData}
            setFormData={setFormData}
            flows={flows}
            isV3TtsModel={isV3TtsModel}
            hasAlternateEngines={hasAlternateEngines}
            availableLLMModels={availableLLMModels}
            isTwilioOpenaiEnabled={isTwilioOpenaiEnabled}
            isPlivoEnabled={isPlivoEnabled}
            isOpenAISipAllowed={isOpenAISipAllowed}
            allowedSttProviders={allowedSttProviders}
            currentSttAllowedModels={currentSttAllowedModels}
            allowedTtsProviders={allowedTtsProviders}
            currentTtsAllowedModels={currentTtsAllowedModels}
            openaiRealtimeModels={openaiRealtimeModels}
            isOrModelsLoading={isOrModelsLoading}
            orModels={orModels}
            orSearch={orSearch}
            setOrSearch={setOrSearch}
            knowledgeBase={knowledgeBase}
            voices={voices}
            hasEmailTemplates={hasEmailTemplates}
            emailTemplates={emailTemplates}
            isWhatsAppActive={isWhatsAppActive}
            whatsappTemplates={whatsappTemplates}
            getWhatsAppTemplateVariables={getWhatsAppTemplateVariables}
            getWhatsAppTemplateButtonVariables={getWhatsAppTemplateButtonVariables}
            getWhatsAppTemplateHeaderInfo={getWhatsAppTemplateHeaderInfo}
            parseWhatsAppVariables={parseWhatsAppVariables}
            handleUpdate={handleUpdate}
            handleCreate={handleCreate}
            createMutation={createMutation}
            updateMutation={updateMutation}
          />

          <AgentDeleteDialog
            deletingAgent={deletingAgent}
            setDeletingAgent={setDeletingAgent}
            t={t}
            deleteMutation={deleteMutation}
          />

          <KnowledgeUploadDialog
            knowledgeUploadOpen={knowledgeUploadOpen}
            setKnowledgeUploadOpen={setKnowledgeUploadOpen}
            t={t}
            knowledgeData={knowledgeData}
            setKnowledgeData={setKnowledgeData}
            uploadKnowledgeMutation={uploadKnowledgeMutation}
          />

          {/* Guided Agent Creation Wizard */}
          <AgentCreationWizard
            open={wizardOpen}
            onOpenChange={setWizardOpen}
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
            }}
          />

          {isDemoMode && (
            <DemoVideoDialog
              isVideoOpen={isVideoOpen}
              setIsVideoOpen={setIsVideoOpen}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
