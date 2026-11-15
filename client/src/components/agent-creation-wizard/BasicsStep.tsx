import { useTranslation } from "react-i18next";
import { Loader2, Info, Phone, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import VoiceSearchPicker from "@/components/VoiceSearchPicker";
import VoicePreviewButton from "@/components/VoicePreviewButton";
import OpenAIVoicePreviewButton from "@/components/OpenAIVoicePreviewButton";
import CVEVoicePreviewButton from "@/components/CVEVoicePreviewButton";
import { SUPPORTED_LANGUAGES, isProviderSupported } from "@/lib/languages";
import { LanguageOptionLabel } from "@/components/LanguageProviderBadges";
import { customVoiceEngineVoices, openaiVoices } from "./constants";
import type { SipPhoneNumber, UseCase, WizardFormData, WizardFormSetter } from "./types";

interface BasicsStepProps {
  formData: WizardFormData;
  setFormData: WizardFormSetter;
  selectedUseCase: UseCase | undefined;
  hasAlternateEngines: boolean;
  isPlivoEnabled: boolean;
  isTwilioOpenaiEnabled: boolean;
  isElevenLabsSipAllowed: boolean;
  isOpenAISipAllowed: boolean;
  isCustomVoiceEngineEnabled: boolean;
  isSipNumbersLoading: boolean;
  sipPhoneNumbers: SipPhoneNumber[];
  activeTtsProvider: string;
}

export function BasicsStep({
  formData,
  setFormData,
  selectedUseCase,
  hasAlternateEngines,
  isPlivoEnabled,
  isTwilioOpenaiEnabled,
  isElevenLabsSipAllowed,
  isOpenAISipAllowed,
  isCustomVoiceEngineEnabled,
  isSipNumbersLoading,
  sipPhoneNumbers,
  activeTtsProvider,
}: BasicsStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div className="text-center mb-6">
        <h3 className="text-lg font-semibold">Basic Information</h3>
        <p className="text-sm text-muted-foreground">
          Name your agent and choose its voice
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Agent Name <span className="text-destructive">*</span></Label>
          <Input
            id="name"
            value={formData.name}
            onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
            placeholder={selectedUseCase ? `My ${selectedUseCase.title} Agent` : "Enter agent name"}
            data-testid="input-agent-name"
          />
        </div>

        {/* Telephony Provider Selection - Only show if alternate engines are enabled */}
        {hasAlternateEngines && (
          <div className="space-y-2">
            <Label>Telephony Provider</Label>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              {/* ElevenLabs + Twilio - Purple theme */}
              <div
                className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                  formData.telephonyProvider === "twilio"
                    ? "border-violet-500 bg-violet-500/10 dark:bg-violet-500/20"
                    : "border-border hover:border-violet-400/50 hover:bg-violet-500/5"
                }`}
                onClick={() => setFormData(prev => ({ ...prev, telephonyProvider: "twilio", sipPhoneNumberId: "" }))}
                data-testid="provider-twilio"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-violet-700 dark:text-violet-300">ElevenLabs + Twilio</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Premium voice quality, 30+ languages
                    </p>
                  </div>
                  {formData.telephonyProvider === "twilio" && (
                    <Check className="h-4 w-4 text-violet-600" />
                  )}
                </div>
              </div>
              {/* OpenAI + Twilio - Teal/Blue theme */}
              {isTwilioOpenaiEnabled && (
                <div
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    formData.telephonyProvider === "twilio_openai"
                      ? "border-brand bg-brand/10 dark:bg-brand/20"
                      : "border-border hover:border-brand/50 hover:bg-brand/5"
                  }`}
                  onClick={() => setFormData(prev => ({ ...prev, telephonyProvider: "twilio_openai", sipPhoneNumberId: "" }))}
                  data-testid="provider-twilio-openai"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-brand">OpenAI + Twilio</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Real-time AI, international
                      </p>
                    </div>
                    {formData.telephonyProvider === "twilio_openai" && (
                      <Check className="h-4 w-4 text-brand" />
                    )}
                  </div>
                </div>
              )}
              {/* OpenAI + Plivo - Green theme */}
              {isPlivoEnabled && (
                <div
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    formData.telephonyProvider === "plivo"
                      ? "border-emerald-500 bg-emerald-500/10 dark:bg-emerald-500/20"
                      : "border-border hover:border-emerald-400/50 hover:bg-emerald-500/5"
                  }`}
                  onClick={() => setFormData(prev => ({ ...prev, telephonyProvider: "plivo", sipPhoneNumberId: "" }))}
                  data-testid="provider-plivo"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-emerald-700 dark:text-emerald-300">OpenAI + Plivo</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Real-time AI, India numbers
                      </p>
                    </div>
                    {formData.telephonyProvider === "plivo" && (
                      <Check className="h-4 w-4 text-emerald-600" />
                    )}
                  </div>
                </div>
              )}
              {/* ElevenLabs SIP - Orange theme */}
              {isElevenLabsSipAllowed && (
                <div
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    formData.telephonyProvider === "elevenlabs-sip"
                      ? "border-orange-500 bg-orange-500/10 dark:bg-orange-500/20"
                      : "border-border hover:border-orange-400/50 hover:bg-orange-500/5"
                  }`}
                  onClick={() => setFormData(prev => ({ ...prev, telephonyProvider: "elevenlabs-sip", sipPhoneNumberId: "" }))}
                  data-testid="provider-elevenlabs-sip"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-orange-700 dark:text-orange-300">ElevenLabs SIP</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-orange-300 text-orange-600 dark:border-orange-600 dark:text-orange-400">Plugin</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Your own SIP trunk
                      </p>
                    </div>
                    {formData.telephonyProvider === "elevenlabs-sip" && (
                      <Check className="h-4 w-4 text-orange-600" />
                    )}
                  </div>
                </div>
              )}
              {/* OpenAI SIP - Pink theme */}
              {isOpenAISipAllowed && (
                <div
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    formData.telephonyProvider === "openai-sip"
                      ? "border-pink-500 bg-pink-500/10 dark:bg-pink-500/20"
                      : "border-border hover:border-pink-400/50 hover:bg-pink-500/5"
                  }`}
                  onClick={() => setFormData(prev => ({ ...prev, telephonyProvider: "openai-sip", sipPhoneNumberId: "" }))}
                  data-testid="provider-openai-sip"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-pink-700 dark:text-pink-300">OpenAI SIP</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-pink-300 text-pink-600 dark:border-pink-600 dark:text-pink-400">Plugin</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Your own SIP trunk
                      </p>
                    </div>
                    {formData.telephonyProvider === "openai-sip" && (
                      <Check className="h-4 w-4 text-pink-600" />
                    )}
                  </div>
                </div>
              )}
              {/* Custom Voice Engine - Indigo/Indigo theme */}
              {isCustomVoiceEngineEnabled && (
                <div
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    formData.telephonyProvider === "custom-voice-engine"
                      ? "border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/20"
                      : "border-border hover:border-indigo-400/50 hover:bg-indigo-500/5"
                  }`}
                  onClick={() => setFormData(prev => ({ ...prev, telephonyProvider: "custom-voice-engine", sipPhoneNumberId: "" }))}
                  data-testid="provider-custom-voice-engine"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-indigo-700 dark:text-indigo-300">Custom Voice Engine</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-indigo-300 text-indigo-600 dark:border-indigo-600 dark:text-indigo-400">Plugin</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Self-hosted FreeSWITCH pipeline
                      </p>
                    </div>
                    {formData.telephonyProvider === "custom-voice-engine" && (
                      <Check className="h-4 w-4 text-indigo-600" />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {(formData.telephonyProvider === "elevenlabs-sip" || formData.telephonyProvider === "openai-sip") && (
          <div className="space-y-2">
            <Label>{t('wizard.sipPhoneNumber', { defaultValue: 'SIP Phone Number' })} <span className="text-destructive">*</span></Label>
            {(() => {
              if (isSipNumbersLoading) {
                return (
                  <div className="flex items-center gap-2 p-3">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{t('wizard.loadingSipNumbers', { defaultValue: 'Loading SIP phone numbers...' })}</span>
                  </div>
                );
              }
              const filtered = sipPhoneNumbers.filter(p => 
                p.engine === formData.telephonyProvider
              );
              if (filtered.length === 0) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-md bg-muted/50 border border-border">
                    <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                    <p className="text-sm text-muted-foreground">
                      {t('wizard.noSipNumbers', { defaultValue: 'No SIP phone numbers available for this engine. Please set up a SIP trunk and import phone numbers in your' })}{' '}
                      <a href="/app/sip" target="_blank" className="text-primary underline underline-offset-2" data-testid="link-sip-settings">
                        {t('wizard.sipSettings', { defaultValue: 'SIP settings' })}
                      </a>{' '}
                      {t('wizard.first', { defaultValue: 'first.' })}
                    </p>
                  </div>
                );
              }
              return (
                <Select
                  value={formData.sipPhoneNumberId}
                  onValueChange={(value) => setFormData(prev => ({ ...prev, sipPhoneNumberId: value }))}
                >
                  <SelectTrigger data-testid="select-sip-phone-number">
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <SelectValue placeholder={t('wizard.selectSipNumber', { defaultValue: 'Select a SIP phone number' })} />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {filtered.map((num) => (
                      <SelectItem key={num.id} value={num.id}>
                        <span>{num.phoneNumber}</span>
                        {num.label && <span className="ml-2 text-muted-foreground">({num.label})</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            })()}
          </div>
        )}

        <div className="grid grid-cols-1 lg:[grid-template-columns:repeat(2,minmax(0,1fr))] gap-4">
          <div className="space-y-2 relative min-w-0">
            <Label>Voice <span className="text-destructive">*</span></Label>
            {formData.telephonyProvider === "custom-voice-engine" ? (
              // Custom Voice Engine Voice Selector
              <div className="flex gap-2 min-w-0">
                <div className="flex-1 min-w-0">
                  <Select
                    value={formData.openaiVoice || "aura-asteria-en"}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, openaiVoice: value }))}
                  >
                    <SelectTrigger data-testid="select-cve-voice" className="w-full">
                      <SelectValue placeholder="Select Voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {customVoiceEngineVoices
                        .filter(v => v.provider === activeTtsProvider)
                        .map((voice) => (
                        <SelectItem key={voice.value} value={voice.value}>
                          <div className="flex flex-col">
                            <span>{voice.label}</span>
                            <span className="text-xs text-muted-foreground">{voice.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <CVEVoicePreviewButton
                  voiceId={formData.openaiVoice || "aura-asteria-en"}
                  voiceName={customVoiceEngineVoices.find(v => v.value === (formData.openaiVoice || "aura-asteria-en"))?.label}
                  provider={customVoiceEngineVoices.find(v => v.value === (formData.openaiVoice || "aura-asteria-en"))?.provider}
                />
              </div>
            ) : (formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? (
              // OpenAI Voice Selector for Plivo, Twilio+OpenAI, or OpenAI SIP
              <div className="flex gap-2 min-w-0">
                <div className="flex-1 min-w-0">
                  <Select
                    value={formData.openaiVoice}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, openaiVoice: value }))}
                  >
                    <SelectTrigger data-testid="select-openai-voice" className="w-full">
                      <SelectValue placeholder="Select OpenAI voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {openaiVoices.map((voice) => (
                        <SelectItem key={voice.value} value={voice.value}>
                          <div className="flex flex-col">
                            <span>{voice.label}</span>
                            <span className="text-xs text-muted-foreground">{voice.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <OpenAIVoicePreviewButton
                  voiceId={formData.openaiVoice}
                  voiceName={openaiVoices.find(v => v.value === formData.openaiVoice)?.label}
                  speed={formData.voiceSpeed}
                />
              </div>
            ) : (
              // ElevenLabs Voice Selector for Twilio or ElevenLabs SIP
              <div className="flex gap-2 min-w-0">
                <div className="flex-1 min-w-0">
                  <VoiceSearchPicker
                    value={formData.elevenLabsVoiceId}
                    onChange={(voiceId) => setFormData(prev => ({ ...prev, elevenLabsVoiceId: voiceId }))}
                    placeholder="Select a voice"
                  />
                </div>
                <VoicePreviewButton
                  voiceId={formData.elevenLabsVoiceId}
                  voiceSettings={{
                    stability: formData.voiceStability,
                    similarity_boost: formData.voiceSimilarityBoost,
                    speed: formData.voiceSpeed,
                  }}
                  onSettingsChange={(settings) => {
                    setFormData(prev => ({
                      ...prev,
                      voiceStability: settings.stability,
                      voiceSimilarityBoost: settings.similarity_boost,
                      voiceSpeed: settings.speed ?? prev.voiceSpeed,
                    }));
                  }}
                  previewText={formData.firstMessage || undefined}
                  language={formData.language || undefined}
                  compact
                />
              </div>
            )}
          </div>

          <div className="space-y-2 min-w-0">
            <Label>Language</Label>
            <Select
              value={formData.language}
              onValueChange={(value) => setFormData(prev => ({ ...prev, language: value }))}
            >
              <SelectTrigger data-testid="select-language">
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_LANGUAGES
                .filter((lang) => {
                  const isElevenLabs = formData.telephonyProvider === "twilio" || formData.telephonyProvider === "elevenlabs-sip";
                  const providerType = isElevenLabs ? "elevenlabs" : "openai";
                  return isProviderSupported(lang.value, providerType);
                })
                .map((lang) => (
                    <SelectItem 
                      key={lang.value} 
                      value={lang.value}
                    >
                      <LanguageOptionLabel 
                        label={t(`agents.languages.${lang.value}`, { defaultValue: lang.label })} 
                        providers={lang.providers} 
                        compact 
                      />
                    </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}
