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
import { Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import VoiceSearchPicker from "@/components/VoiceSearchPicker";
import VoicePreviewButton from "@/components/VoicePreviewButton";
import OpenAIVoicePreviewButton from "@/components/OpenAIVoicePreviewButton";
import CVEVoicePreviewButton from "@/components/CVEVoicePreviewButton";
import { SUPPORTED_LANGUAGES, isProviderSupported } from "@/lib/languages";
import { LanguageOptionLabel } from "@/components/LanguageProviderBadges";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { formatModelName, openaiVoices, customVoiceEngineVoices, Voice, AgentFormData } from "@/pages/agents/shared";

export interface IncomingVoiceSelectionProps {
  t: TFunction<"translation", undefined>;
  formData: AgentFormData;
  allowedSttProviders: string[];
  currentSttAllowedModels: string[];
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
  allowedTtsProviders: string[];
  currentTtsAllowedModels: string[];
  voices: Voice[];
}

export function IncomingVoiceSelection({ t, formData, allowedSttProviders, currentSttAllowedModels, setFormData, allowedTtsProviders, currentTtsAllowedModels, voices }: IncomingVoiceSelectionProps) {
  return (
    <div className="grid grid-cols-2 gap-4 overflow-visible">
                    <div className="space-y-2 relative z-20">
                      <div className="flex items-center">
                        <Label htmlFor="voice">
                          {t('agents.create.voiceRequired')} <span className="text-destructive">*</span>
                        </Label>
                        <InfoTooltip content={t('agents.create.voiceTooltip')} />
                      </div>
                      {formData.telephonyProvider === "custom-voice-engine" ? (
                        <div className="space-y-4">
                          {/* Provider Selection */}
                          <div className="grid grid-cols-2 gap-4">
                            {(allowedSttProviders.length > 1 || true) && (
                              <div className="space-y-2 relative z-30">
                                <Label>STT Provider</Label>
                                <Select
                                  value={formData.sttProvider || allowedSttProviders[0]}
                                  onValueChange={(value) => {
                                    const defaultModel = value === 'sarvam' ? (currentSttAllowedModels[0] || 'saaras:v3') : '';
                                    setFormData({ ...formData, sttProvider: value, sttModel: defaultModel });
                                  }}
                                  disabled={allowedSttProviders.length <= 1}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Select STT Provider" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {allowedSttProviders.map((p) => (
                                      <SelectItem key={p} value={p}>
                                        {p === 'deepgram' ? 'Deepgram' : 'Sarvam AI'}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}

                            {(allowedTtsProviders.length > 1 || true) && (
                              <div className="space-y-2 relative z-30">
                                <Label>TTS Provider</Label>
                                <Select
                                  value={formData.ttsProvider || allowedTtsProviders[0]}
                                  onValueChange={(value) => {
                                    const firstVoice = customVoiceEngineVoices.find(v => v.provider === value);
                                    const defaultModel = value === 'sarvam' ? (currentTtsAllowedModels[0] || 'bulbul:v3') : '';
                                    setFormData({
                                      ...formData,
                                      ttsProvider: value,
                                      ttsModel: defaultModel,
                                      openaiVoice: firstVoice ? firstVoice.value : formData.openaiVoice
                                    });
                                  }}
                                  disabled={allowedTtsProviders.length <= 1}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Select TTS Provider" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {allowedTtsProviders.map((p) => (
                                      <SelectItem key={p} value={p}>
                                        {p === 'deepgram' ? 'Deepgram' : p === 'sarvam' ? 'Sarvam AI' : 'ElevenLabs'}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}

                            {currentSttAllowedModels.length > 0 && (
                              <div className="space-y-2 relative z-30">
                                <Label>STT Model</Label>
                                <Select
                                  value={formData.sttModel || currentSttAllowedModels[0]}
                                  onValueChange={(value) => setFormData({ ...formData, sttModel: value })}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Select STT Model" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {currentSttAllowedModels.map((m) => (
                                      <SelectItem key={m} value={m}>{formatModelName(m)}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}

                            {currentTtsAllowedModels.length > 0 && (formData.ttsProvider === 'sarvam' || formData.ttsProvider === 'deepgram' || formData.ttsProvider === 'elevenlabs') && (
                              <div className="space-y-2 relative z-30">
                                <Label>TTS Model</Label>
                                <Select
                                  value={formData.ttsModel || currentTtsAllowedModels[0]}
                                  onValueChange={(value) => {
                                    if (formData.ttsProvider === 'deepgram' || formData.ttsProvider === 'elevenlabs') {
                                      setFormData({ ...formData, ttsModel: value });
                                    } else {
                                      const firstVoice = customVoiceEngineVoices.find(
                                        v => v.provider === 'sarvam' && (v as any).model === value && (!(v as any).languages || !formData.language || (v as any).languages.includes(formData.language))
                                      );
                                      setFormData({ ...formData, ttsModel: value, openaiVoice: firstVoice?.value || formData.openaiVoice });
                                    }
                                  }}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Select TTS Model" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {currentTtsAllowedModels.map((m) => (
                                      <SelectItem key={m} value={m}>{formatModelName(m)}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                          </div>

                          <div className="flex gap-2 relative z-20">
                            <div className="flex-1">
                              <Select
                                value={formData.openaiVoice || "aura-asteria-en"}
                                onValueChange={(value) => setFormData({ ...formData, openaiVoice: value })}
                              >
                                <SelectTrigger data-testid="select-cve-voice">
                                  <SelectValue placeholder="Select Voice" />
                                </SelectTrigger>
                                <SelectContent>
                                  {formData.ttsProvider === 'elevenlabs' ? (
                                    voices.map((v) => (
                                      <SelectItem key={v.voice_id} value={v.voice_id}>
                                        {v.name} ({v.category || 'Custom'})
                                      </SelectItem>
                                    ))
                                  ) : (
                                    customVoiceEngineVoices
                                      .filter(v => v.provider === (formData.ttsProvider || allowedTtsProviders[0]))
                                      .filter(v => {
                                        if (formData.ttsProvider === 'deepgram') {
                                          const modelKey = v.value.startsWith('aura-2') ? 'aura-2' : 'aura';
                                          const voiceLang = v.value.split('-').pop() || '';
                                          return currentTtsAllowedModels.includes(modelKey) && (!formData.language || voiceLang.toLowerCase() === formData.language.toLowerCase());
                                        }
                                        if (formData.ttsProvider === 'sarvam') {
                                          const sv = v as { model?: string; languages?: string[] };
                                          const matchesModel = !sv.model || !formData.ttsModel || sv.model === formData.ttsModel;
                                          const matchesLanguage = !sv.languages || !formData.language || sv.languages.includes(formData.language);
                                          return matchesModel && matchesLanguage;
                                        }
                                        return true;
                                      })
                                      .length > 0 ? (
                                      customVoiceEngineVoices
                                        .filter(v => v.provider === (formData.ttsProvider || allowedTtsProviders[0]))
                                        .filter(v => {
                                          if (formData.ttsProvider === 'deepgram') {
                                            const modelKey = v.value.startsWith('aura-2') ? 'aura-2' : 'aura';
                                            const voiceLang = v.value.split('-').pop() || '';
                                            return currentTtsAllowedModels.includes(modelKey) && (!formData.language || voiceLang.toLowerCase() === formData.language.toLowerCase());
                                          }
                                          if (formData.ttsProvider === 'sarvam') {
                                            const sv = v as { model?: string; languages?: string[] };
                                            const matchesModel = !sv.model || !formData.ttsModel || sv.model === formData.ttsModel;
                                            const matchesLanguage = !sv.languages || !formData.language || sv.languages.includes(formData.language);
                                            return matchesModel && matchesLanguage;
                                          }
                                          return true;
                                        })
                                        .map((voice) => (
                                          <SelectItem key={voice.value} value={voice.value}>
                                            <div className="flex flex-col">
                                              <span>{voice.label}</span>
                                              <span className="text-xs text-muted-foreground">{voice.description}</span>
                                            </div>
                                          </SelectItem>
                                        ))
                                      ) : (
                                        <SelectItem value="none" disabled>
                                          No voices available for {formData.language?.toUpperCase() || 'this language'}
                                        </SelectItem>
                                      )
                                  )}
                                </SelectContent>
                              </Select>
                            </div>
                            <CVEVoicePreviewButton
                              voiceId={formData.openaiVoice || "aura-asteria-en"}
                              voiceName={customVoiceEngineVoices.find(v => v.value === (formData.openaiVoice || "aura-asteria-en"))?.label}
                              provider={customVoiceEngineVoices.find(v => v.value === (formData.openaiVoice || "aura-asteria-en"))?.provider}
                              language={formData.language || undefined}
                              ttsModel={formData.ttsModel}
                              previewText={formData.firstMessage || undefined}
                            />
                          </div>
                        </div>
                      ) : (formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? (
                        <div className="flex gap-2">
                          <div className="flex-1">
                            <Select
                              value={formData.openaiVoice}
                              onValueChange={(value) => setFormData({ ...formData, openaiVoice: value })}
                            >
                              <SelectTrigger data-testid="select-openai-voice">
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
                            speed={formData.voiceSpeed ?? 1.0}
                            language={formData.language || undefined}
                            previewText={formData.firstMessage || undefined}
                          />
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <VoiceSearchPicker
                              value={formData.elevenLabsVoiceId}
                              onChange={(voiceId) => setFormData({ ...formData, elevenLabsVoiceId: voiceId })}
                              placeholder={t('agents.create.selectVoicePlaceholder')}
                            />
                          </div>
                          <VoicePreviewButton
                            voiceId={formData.elevenLabsVoiceId}
                            voiceSettings={{
                              stability: formData.voiceStability ?? 0.5,
                              similarity_boost: formData.voiceSimilarityBoost ?? 0.75,
                              speed: formData.voiceSpeed ?? 1.0,
                            }}
                            onSettingsChange={(settings) => {
                              setFormData({
                                ...formData,
                                voiceStability: settings.stability,
                                voiceSimilarityBoost: settings.similarity_boost,
                                voiceSpeed: settings.speed,
                              });
                            }}
                            previewText={formData.firstMessage || undefined}
                            language={formData.language || undefined}
                            compact
                          />
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center">
                        <Label htmlFor="language">
                          {t('agents.create.languageRequired')} <span className="text-destructive">*</span>
                        </Label>
                        <InfoTooltip content={t('agents.create.languageTooltip')} />
                      </div>
                      <Select
                        value={formData.language}
                        onValueChange={(value) => setFormData({ ...formData, language: value })}
                      >
                        <SelectTrigger id="language" data-testid="select-language">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SUPPORTED_LANGUAGES
                            .filter((lang) => {
                              if (formData.telephonyProvider === "custom-voice-engine") {
                                const sarvamLangs = ["en", "hi", "bn", "kn", "ml", "mr", "or", "pa", "ta", "te", "gu"];
                                // Deepgram STT supports many, Deepgram TTS supports only English
                                const deepgramSttLangs = ["en", "fr", "de", "hi", "pt", "es", "it", "ja", "ko", "nl", "pl", "ru", "sv", "tr", "uk", "zh", "ta", "te", "th"];
                                const deepgramTtsLangs = ["en", "es", "de", "fr", "nl", "it", "ja"];

                                // Determine STT languages
                                const sttLangs = formData.sttProvider === "sarvam" ? sarvamLangs : deepgramSttLangs;
                                // Determine TTS languages
                                const ttsLangs = formData.ttsProvider === "sarvam" ? sarvamLangs : deepgramTtsLangs;

                                // The language must be supported by BOTH STT and TTS
                                return sttLangs.includes(lang.value) && ttsLangs.includes(lang.value);
                              }

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
                                  providers={formData.telephonyProvider === "custom-voice-engine" ? [] : lang.providers}
                                  compact
                                />
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground mt-1.5 flex items-start gap-1">
                        <Info className="h-3.5 w-3.5 shrink-0 text-blue-500 mt-0.5" />
                        <span>{t('agents.create.languagePerformanceHint', 'Provide the system prompt and first message in the selected language for better performance and higher accuracy.')}</span>
                      </p>
                    </div>
                  </div>
  );
}
