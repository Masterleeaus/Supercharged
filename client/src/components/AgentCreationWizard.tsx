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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ChevronLeft, ChevronRight, Wand2, FileText, Check, Loader2, Zap } from "lucide-react";

import PromptTemplatesLibrary from "@/components/PromptTemplatesLibrary";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

import { usePluginStatus } from "@/hooks/use-plugin-status";

import { AgentFormData, AgentCreationWizardProps, SipPhoneNumber, WizardStep, steps, useCases, voiceToneOptions, personalityOptions, customVoiceEngineVoices } from "@/components/agent-creation/constants";
import { BasicsStep } from "@/components/agent-creation/BasicsStep";
import { VoiceStep } from "@/components/agent-creation/VoiceStep";
import { ReviewStep } from "@/components/agent-creation/ReviewStep";

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

  const [formData, setFormData] = useState<AgentFormData>({
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

  const getColorClasses = (color: string, selected: boolean) => {
    const colors: Record<string, { bg: string; border: string; text: string; icon: string }> = {
      emerald: {
        bg: selected ? "bg-emerald-500/20 dark:bg-emerald-500/30" : "bg-muted/30 hover:bg-muted/50",
        border: selected ? "border-emerald-500/50" : "border-transparent hover:border-border",
        text: selected ? "text-emerald-700 dark:text-emerald-300" : "",
        icon: selected ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground",
      },
      blue: {
        bg: selected ? "bg-blue-500/20 dark:bg-blue-500/30" : "bg-muted/30 hover:bg-muted/50",
        border: selected ? "border-blue-500/50" : "border-transparent hover:border-border",
        text: selected ? "text-blue-700 dark:text-blue-300" : "",
        icon: selected ? "bg-blue-500/20 text-blue-600 dark:text-blue-400" : "bg-muted text-muted-foreground",
      },
      violet: {
        bg: selected ? "bg-violet-500/20 dark:bg-violet-500/30" : "bg-muted/30 hover:bg-muted/50",
        border: selected ? "border-violet-500/50" : "border-transparent hover:border-border",
        text: selected ? "text-violet-700 dark:text-violet-300" : "",
        icon: selected ? "bg-violet-500/20 text-violet-600 dark:text-violet-400" : "bg-muted text-muted-foreground",
      },
      amber: {
        bg: selected ? "bg-amber-500/20 dark:bg-amber-500/30" : "bg-muted/30 hover:bg-muted/50",
        border: selected ? "border-amber-500/50" : "border-transparent hover:border-border",
        text: selected ? "text-amber-700 dark:text-amber-300" : "",
        icon: selected ? "bg-amber-500/20 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground",
      },
      rose: {
        bg: selected ? "bg-rose-500/20 dark:bg-rose-500/30" : "bg-muted/30 hover:bg-muted/50",
        border: selected ? "border-rose-500/50" : "border-transparent hover:border-border",
        text: selected ? "text-rose-700 dark:text-rose-300" : "",
        icon: selected ? "bg-rose-500/20 text-rose-600 dark:text-rose-400" : "bg-muted text-muted-foreground",
      },
      slate: {
        bg: selected ? "bg-slate-500/20 dark:bg-slate-500/30" : "bg-muted/30 hover:bg-muted/50",
        border: selected ? "border-slate-500/50" : "border-transparent hover:border-border",
        text: selected ? "text-slate-700 dark:text-slate-300" : "",
        icon: selected ? "bg-slate-500/20 text-slate-600 dark:text-slate-400" : "bg-muted text-muted-foreground",
      },
    };
    return colors[color] || colors.slate;
  };

  const renderStep = () => {
    switch (currentStep) {
      case "useCase":
        return (
          <div className="space-y-4">
            <div className="text-center mb-6">
              <h3 className="text-lg font-semibold">What will your AI agent do?</h3>
              <p className="text-sm text-muted-foreground">
                Choose a use case to get started with optimized settings
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {useCases.map((useCase) => {
                const selected = formData.useCase === useCase.id;
                const colors = getColorClasses(useCase.color, selected);
                return (
                  <div
                    key={useCase.id}
                    className={`relative p-4 rounded-xl cursor-pointer transition-all duration-200 border-2 ${colors.bg} ${colors.border}`}
                    onClick={() => handleUseCaseSelect(useCase.id)}
                    data-testid={`usecase-${useCase.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ${colors.icon}`}>
                        <useCase.icon className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className={`font-semibold ${colors.text}`}>{useCase.title}</h4>
                          {selected && <Check className="h-4 w-4 text-emerald-500" />}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {useCase.description}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );

      case "basics":
        return (
          <BasicsStep
            formData={formData}
            setFormData={setFormData}
            sipPhoneNumbers={sipPhoneNumbers}
            isSipNumbersLoading={isSipNumbersLoading}
            isElevenLabsSipAllowed={isElevenLabsSipAllowed}
            isOpenAISipAllowed={isOpenAISipAllowed}
            isPlivoEnabled={isPlivoEnabled}
            isTwilioOpenaiEnabled={isTwilioOpenaiEnabled}
            isCustomVoiceEngineEnabled={isCustomVoiceEngineEnabled}
            hasAlternateEngines={hasAlternateEngines}
            activeTtsProvider={activeTtsProvider}
            selectedUseCase={selectedUseCase}
          />
        );

      case "personality":
        return (
          <div className="space-y-6">
            <div className="text-center mb-6">
              <h3 className="text-lg font-semibold">Personality & Tone</h3>
              <p className="text-sm text-muted-foreground">
                Define how your agent sounds and behaves
              </p>
            </div>

            <div className="space-y-6">
              <div className="space-y-3">
                <Label className="text-sm font-medium">Voice Tone</Label>
                <div className="grid grid-cols-1 gap-2">
                  {voiceToneOptions.map((option) => (
                    <div
                      key={option.value}
                      className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                        formData.voiceTone === option.value
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                      }`}
                      onClick={() => setFormData(prev => ({ ...prev, voiceTone: option.value }))}
                      data-testid={`tone-${option.value}`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium">{option.label}</span>
                          <span className="text-xs text-muted-foreground ml-2">
                            {option.description}
                          </span>
                        </div>
                        {formData.voiceTone === option.value && (
                          <Check className="h-4 w-4 text-primary" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <Label className="text-sm font-medium">Personality</Label>
                <div className="grid grid-cols-2 gap-2">
                  {personalityOptions.map((option) => (
                    <div
                      key={option.value}
                      className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                        formData.personality === option.value
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                      }`}
                      onClick={() => setFormData(prev => ({ ...prev, personality: option.value }))}
                      data-testid={`personality-${option.value}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{option.label}</span>
                        {formData.personality === option.value && (
                          <Check className="h-3 w-3 text-primary" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {option.description}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );

      case "prompts":
        return (
          <div className="space-y-6">
            <div className="text-center mb-4">
              <h3 className="text-lg font-semibold">Configure Prompts</h3>
              <p className="text-sm text-muted-foreground">
                Customize what your agent says and how it behaves
              </p>
            </div>

            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTemplatesOpen(true)}
                data-testid="button-use-template"
              >
                <FileText className="h-4 w-4 mr-2" />
                Use Template
              </Button>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="systemPrompt">
                  System Prompt <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="systemPrompt"
                  value={formData.systemPrompt}
                  onChange={(e) => setFormData(prev => ({ ...prev, systemPrompt: e.target.value }))}
                  placeholder="Describe your agent's role, responsibilities, and behavior guidelines..."
                  className="min-h-[150px] resize-none"
                  data-testid="textarea-system-prompt"
                />
                <p className="text-xs text-muted-foreground">
                  Use {"{{variable}}"} syntax for dynamic values like {"{{company_name}}"} or {"{{agent_name}}"}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="firstMessage">First Message</Label>
                <Textarea
                  id="firstMessage"
                  value={formData.firstMessage}
                  onChange={(e) => setFormData(prev => ({ ...prev, firstMessage: e.target.value }))}
                  placeholder="What your agent says when answering a call..."
                  className="min-h-[80px] resize-none"
                  data-testid="textarea-first-message"
                />
                <p className="text-xs text-muted-foreground">
                  Best practices: Start warm and natural. Example: "Hi {'{{first_name}}'}, this is Sarah from ABC Corp, how's your day going?"
                </p>
                
                {/* Dynamic Variables Helper */}
                <div className="mt-2 p-3 bg-muted/50 rounded-md border border-muted">
                  <p className="text-xs font-medium text-foreground mb-2">Available Dynamic Variables</p>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {['{{first_name}}', '{{last_name}}', '{{contact_name}}', '{{email}}', '{{phone}}', '{{city}}', '{{company}}'].map((variable) => (
                      <Badge 
                        key={variable} 
                        variant="secondary" 
                        className="text-xs font-mono cursor-pointer hover-elevate"
                        onClick={() => {
                          setFormData(prev => ({ ...prev, firstMessage: prev.firstMessage + variable }));
                        }}
                        data-testid={`badge-wizard-variable-${variable.replace(/[{}]/g, '')}`}
                      >
                        {variable}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Click to insert. Variables are replaced with contact data from your campaign CSV.</p>
                </div>
              </div>
            </div>

            <Dialog open={templatesOpen} onOpenChange={setTemplatesOpen}>
              <DialogContent className="max-w-4xl max-h-[80vh]">
                <DialogHeader>
                  <DialogTitle>Prompt Templates</DialogTitle>
                  <DialogDescription>
                    Choose a template to use as a starting point
                  </DialogDescription>
                </DialogHeader>
                <ScrollArea className="max-h-[60vh]">
                  <PromptTemplatesLibrary
                    mode="select"
                    onSelectTemplate={(template) => {
                      setFormData(prev => ({
                        ...prev,
                        systemPrompt: template.systemPrompt,
                        firstMessage: template.firstMessage || prev.firstMessage,
                        voiceTone: template.suggestedVoiceTone || prev.voiceTone,
                        personality: template.suggestedPersonality || prev.personality,
                      }));
                      setTemplatesOpen(false);
                      toast({
                        title: "Template Applied",
                        description: "Template has been applied to your agent.",
                      });
                    }}
                  />
                </ScrollArea>
              </DialogContent>
            </Dialog>
          </div>
        );

      case "voice":
        return (
          <VoiceStep formData={formData} setFormData={setFormData} isV3TtsModel={isV3TtsModel} />
        );

      case "review":
        return (
          <ReviewStep formData={formData} hasAlternateEngines={hasAlternateEngines} selectedUseCase={selectedUseCase} />
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

export { customVoiceEngineVoices };
