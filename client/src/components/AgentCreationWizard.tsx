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
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Wand2, ChevronLeft, ChevronRight, Zap } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { usePluginStatus } from "@/hooks/use-plugin-status";
import { useCases, steps } from "./agent-creation-wizard/constants";
import type { SipPhoneNumber, WizardFormData, WizardStep } from "./agent-creation-wizard/types";
import { UseCaseStep } from "./agent-creation-wizard/UseCaseStep";
import { BasicsStep } from "./agent-creation-wizard/BasicsStep";
import { PersonalityStep } from "./agent-creation-wizard/PersonalityStep";
import { PromptsStep } from "./agent-creation-wizard/PromptsStep";
import { VoiceStep } from "./agent-creation-wizard/VoiceStep";
import { ReviewStep } from "./agent-creation-wizard/ReviewStep";

export { customVoiceEngineVoices } from "./agent-creation-wizard/constants";

interface AgentCreationWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function AgentCreationWizard({ open, onOpenChange, onSuccess }: AgentCreationWizardProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState<WizardStep>("useCase");
  const [templatesOpen, setTemplatesOpen] = useState(false);

  // Fetch voice engine setting to check if Plivo+OpenAI or Twilio+OpenAI is enabled
  const { data: voiceEngineSettings } = useQuery<{ plivo_openai_engine_enabled: boolean; twilio_openai_engine_enabled: boolean; default_tts_model?: string }>({
    queryKey: ["/api/settings/voice-engine"],
    staleTime: 60000, // Cache for 1 minute
  });

  // Check if SIP plugin is enabled and which engines are allowed
  const { isSipPluginEnabled, sipEnginesAllowed, isCustomVoiceEngineEnabled } = usePluginStatus();
  const isElevenLabsSipAllowed = isSipPluginEnabled && sipEnginesAllowed.includes("elevenlabs-sip");
  const isOpenAISipAllowed = isSipPluginEnabled && sipEnginesAllowed.includes("openai-sip");

  // Fetch SIP phone numbers when SIP plugin is enabled
  const { data: sipPhoneNumbersResponse, isLoading: isSipNumbersLoading } = useQuery<{ success: boolean; data: SipPhoneNumber[] }>({
    queryKey: ["/api/sip/phone-numbers"],
    enabled: isSipPluginEnabled,
  });
  const sipPhoneNumbers = sipPhoneNumbersResponse?.data || [];

  const isPlivoEnabled = voiceEngineSettings?.plivo_openai_engine_enabled ?? false;
  const isTwilioOpenaiEnabled = voiceEngineSettings?.twilio_openai_engine_enabled ?? false;
  const isV3TtsModel = (voiceEngineSettings?.default_tts_model || '').includes('v3');
  const hasAlternateEngines = isPlivoEnabled || isTwilioOpenaiEnabled || isElevenLabsSipAllowed || isOpenAISipAllowed || isCustomVoiceEngineEnabled;

  // Fetch CVE admin settings for active TTS provider
  const { data: cveSettings } = useQuery<{ success: boolean; data: { tts: { activeProvider: string } } }>({
    queryKey: ["/api/voice-engine/admin/provider-keys"],
    staleTime: 30000,
    enabled: isCustomVoiceEngineEnabled,
  });
  const activeTtsProvider = cveSettings?.data?.tts?.activeProvider || "deepgram";
  const activeSttProvider = (cveSettings?.data as any)?.stt?.activeProvider || "deepgram";

  const [formData, setFormData] = useState<WizardFormData>({
    useCase: "",
    name: "",
    elevenLabsVoiceId: "",
    language: "en",
    voiceTone: "professional",
    personality: "helpful",
    systemPrompt: "",
    firstMessage: "",
    voiceStability: 0.5,
    voiceSimilarityBoost: 0.85,
    voiceSpeed: 1.0,
    turnTimeout: 1.5,
    // Telephony provider selection
    telephonyProvider: "twilio" as "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine",
    openaiVoice: "alloy",
    // SIP phone number selection (for SIP engines)
    sipPhoneNumberId: "",
  });

  const selectedUseCase = useMemo(() => 
    useCases.find(uc => uc.id === formData.useCase),
    [formData.useCase]
  );

  const currentStepIndex = steps.findIndex(s => s.id === currentStep);
  const progress = ((currentStepIndex + 1) / steps.length) * 100;

  const canProceed = useMemo(() => {
    switch (currentStep) {
      case "useCase":
        return !!formData.useCase;
      case "basics":
        // Voice validation depends on telephony provider
        const isOpenAIOrCve = formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip" || formData.telephonyProvider === "custom-voice-engine";
        const hasValidVoice = isOpenAIOrCve
          ? !!formData.openaiVoice 
          : !!formData.elevenLabsVoiceId;
        // SIP engines require a phone number selection
        const isSipEngine = formData.telephonyProvider === "elevenlabs-sip" || formData.telephonyProvider === "openai-sip";
        const hasSipPhoneNumber = !isSipEngine || !!formData.sipPhoneNumberId;
        return !!formData.name && hasValidVoice && hasSipPhoneNumber;
      case "personality":
        return !!formData.voiceTone && !!formData.personality;
      case "prompts":
        return !!formData.systemPrompt;
      case "voice":
        return true;
      case "review":
        return true;
      default:
        return false;
    }
  }, [currentStep, formData]);

  const validationHint = useMemo(() => {
    if (canProceed || currentStep !== "basics") return null;
    const missing: string[] = [];
    if (!formData.name) missing.push(t('wizard.hint.enterName', { defaultValue: 'enter an agent name' }));
    const isOpenAIOrCve = formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip" || formData.telephonyProvider === "custom-voice-engine";
    const isSipEngine = formData.telephonyProvider === "elevenlabs-sip" || formData.telephonyProvider === "openai-sip";
    if (isOpenAIOrCve && !formData.openaiVoice) {
      missing.push(t('wizard.hint.selectVoice', { defaultValue: 'select a voice' }));
    } else if (!isOpenAIOrCve && !formData.elevenLabsVoiceId) {
      missing.push(t('wizard.hint.selectVoice', { defaultValue: 'select a voice' }));
    }
    if (isSipEngine && !formData.sipPhoneNumberId) {
      missing.push(t('wizard.hint.selectSipNumber', { defaultValue: 'select a SIP phone number' }));
    }
    if (missing.length === 0) return null;
    return t('wizard.hint.toContinue', { 
      defaultValue: 'Please {{items}} to continue',
      items: missing.join(` ${t('wizard.hint.and', { defaultValue: 'and' })} `)
    });
  }, [canProceed, currentStep, formData, t]);

  const handleUseCaseSelect = (useCaseId: string) => {
    const useCase = useCases.find(uc => uc.id === useCaseId);
    if (useCase) {
      setFormData(prev => ({
        ...prev,
        useCase: useCaseId,
        voiceTone: useCase.presetVoiceTone,
        personality: useCase.presetPersonality,
        systemPrompt: useCase.suggestedPrompt,
        firstMessage: useCase.suggestedFirstMessage,
      }));
    }
  };

  const goNext = () => {
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < steps.length) {
      setCurrentStep(steps[nextIndex].id);
    }
  };

  const goBack = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(steps[prevIndex].id);
    }
  };

  const resetWizard = () => {
    setCurrentStep("useCase");
    setFormData({
      useCase: "",
      name: "",
      elevenLabsVoiceId: "",
      language: "en",
      voiceTone: "professional",
      personality: "helpful",
      systemPrompt: "",
      firstMessage: "",
      voiceStability: 0.5,
      voiceSimilarityBoost: 0.85,
      voiceSpeed: 1.0,
      turnTimeout: 1.5,
      telephonyProvider: "twilio",
      openaiVoice: "alloy",
      sipPhoneNumberId: "",
    });
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (formData.telephonyProvider === "custom-voice-engine") {
        const payload = {
          name: formData.name,
          description: "",
          systemPrompt: formData.systemPrompt,
          firstMessage: formData.firstMessage || "Hello! How can I help you today?",
          language: formData.language || "en",
          llmModel: "openai/gpt-4o-mini",
          temperature: 0.7,
          maxTokens: 500,
          ttsVoice: formData.openaiVoice || "aura-asteria-en",
          ttsProvider: activeTtsProvider,
          sttProvider: activeSttProvider,
          interruptible: true,
          silenceTimeoutMs: 5000,
          maxDurationSeconds: 600,
          endCallOnSilence: false,
          businessRules: [],
          enableMemory: true,
          memoryRetentionDays: 90,
        };
        const res = await apiRequest("POST", "/api/voice-engine/agents", payload);
        return res.json();
      }

      const isSipEngine = formData.telephonyProvider === "elevenlabs-sip" || formData.telephonyProvider === "openai-sip";
      const isOpenAIVoice = formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip";
      const isElevenLabsVoice = formData.telephonyProvider === "twilio" || formData.telephonyProvider === "elevenlabs-sip";
      
      const payload = {
        type: "incoming",
        name: formData.name,
        elevenLabsVoiceId: isElevenLabsVoice ? formData.elevenLabsVoiceId : undefined,
        openaiModel: isOpenAIVoice ? "gpt-realtime-1.5" : undefined,
        language: formData.language,
        voiceTone: formData.voiceTone,
        personality: formData.personality,
        systemPrompt: formData.systemPrompt,
        firstMessage: formData.firstMessage || "Hello! How can I help you today?",
        voiceStability: formData.voiceStability,
        voiceSimilarityBoost: formData.voiceSimilarityBoost,
        voiceSpeed: formData.voiceSpeed,
        turnTimeout: formData.turnTimeout,
        temperature: 0.5,
        // Telephony provider configuration
        telephonyProvider: formData.telephonyProvider,
        openaiVoice: isOpenAIVoice ? formData.openaiVoice : undefined,
        // SIP configuration
        sipPhoneNumberId: isSipEngine ? formData.sipPhoneNumberId : undefined,
      };
      const res = await apiRequest("POST", "/api/agents", payload);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Agent Created!",
        description: `Your ${formData.name} agent is ready to use.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/voice-engine/agents"] });
      onOpenChange(false);
      resetWizard();
      onSuccess?.();
    },
    onError: (error: any) => {
      toast({
        title: "Creation Failed",
        description: error.message || "Failed to create agent. Please try again.",
        variant: "destructive",
      });
    },
  });

  const renderStep = () => {
    switch (currentStep) {
      case "useCase":
        return <UseCaseStep formData={formData} handleUseCaseSelect={handleUseCaseSelect} />;
      case "basics":
        return (
          <BasicsStep
            formData={formData}
            setFormData={setFormData}
            selectedUseCase={selectedUseCase}
            hasAlternateEngines={hasAlternateEngines}
            isPlivoEnabled={isPlivoEnabled}
            isTwilioOpenaiEnabled={isTwilioOpenaiEnabled}
            isElevenLabsSipAllowed={isElevenLabsSipAllowed}
            isOpenAISipAllowed={isOpenAISipAllowed}
            isCustomVoiceEngineEnabled={isCustomVoiceEngineEnabled}
            isSipNumbersLoading={isSipNumbersLoading}
            sipPhoneNumbers={sipPhoneNumbers}
            activeTtsProvider={activeTtsProvider}
          />
        );
      case "personality":
        return <PersonalityStep formData={formData} setFormData={setFormData} />;
      case "prompts":
        return (
          <PromptsStep
            formData={formData}
            setFormData={setFormData}
            templatesOpen={templatesOpen}
            setTemplatesOpen={setTemplatesOpen}
          />
        );
      case "voice":
        return <VoiceStep formData={formData} setFormData={setFormData} isV3TtsModel={isV3TtsModel} />;
      case "review":
        return (
          <ReviewStep
            formData={formData}
            selectedUseCase={selectedUseCase}
            hasAlternateEngines={hasAlternateEngines}
          />
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) {
        resetWizard();
      }
      onOpenChange(isOpen);
    }}>
      <DialogContent className="max-w-3xl max-h-[90vh] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <Wand2 className="h-5 w-5 text-primary" />
                Create AI Agent
              </DialogTitle>
              <DialogDescription>
                Step {currentStepIndex + 1} of {steps.length}: {steps[currentStepIndex].title}
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              {steps.map((step, index) => (
                <div
                  key={step.id}
                  className={`h-2 w-2 rounded-full transition-colors ${
                    index < currentStepIndex
                      ? "bg-emerald-500"
                      : index === currentStepIndex
                      ? "bg-primary"
                      : "bg-muted"
                  }`}
                />
              ))}
            </div>
          </div>
          <Progress value={progress} className="h-1 mt-4" />
        </DialogHeader>

        <ScrollArea className="flex-1 max-h-[55vh]">
          <div className="p-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentStep}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                {renderStep()}
              </motion.div>
            </AnimatePresence>
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between px-6 py-4 border-t bg-muted/30">
          <Button
            variant="ghost"
            onClick={goBack}
            disabled={currentStepIndex === 0}
            data-testid="button-wizard-back"
          >
            <ChevronLeft className="h-4 w-4 mr-2" />
            Back
          </Button>

          {currentStep === "review" ? (
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              className="min-w-[140px]"
              data-testid="button-wizard-create"
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  Create Agent
                </>
              )}
            </Button>
          ) : (
            <div className="flex flex-col items-end gap-1">
              <Button
                onClick={goNext}
                disabled={!canProceed}
                data-testid="button-wizard-next"
              >
                Continue
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
              {validationHint && (
                <p className="text-xs text-muted-foreground" data-testid="text-wizard-hint">
                  {validationHint}
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default AgentCreationWizard;
