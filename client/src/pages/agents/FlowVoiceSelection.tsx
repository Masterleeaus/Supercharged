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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import VoiceSearchPicker from "@/components/VoiceSearchPicker";
import VoicePreviewButton from "@/components/VoicePreviewButton";
import CVEVoicePreviewButton from "@/components/CVEVoicePreviewButton";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { formatModelName, openaiVoices, customVoiceEngineVoices, AgentFormData } from "@/pages/agents/shared";

export interface FlowVoiceSelectionProps {
  t: TFunction<"translation", undefined>;
  formData: AgentFormData;
  allowedSttProviders: string[];
  currentSttAllowedModels: string[];
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
  allowedTtsProviders: string[];
  currentTtsAllowedModels: string[];
}

export function FlowVoiceSelection({ t, formData, allowedSttProviders, currentSttAllowedModels, setFormData, allowedTtsProviders, currentTtsAllowedModels }: FlowVoiceSelectionProps) {
  return (
    <div className="space-y-2">
                        <div className="flex items-center">
                          <Label htmlFor="flow-voice">
                            Voice <span className="text-destructive">*</span>
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
                                          {p === 'deepgram' ? 'Deepgram' : 'Sarvam AI'}
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

                              {currentTtsAllowedModels.length > 0 && (formData.ttsProvider === 'sarvam' || formData.ttsProvider === 'deepgram') && (
                                <div className="space-y-2 relative z-30">
                                  <Label>TTS Model</Label>
                                  <Select
                                    value={formData.ttsModel || currentTtsAllowedModels[0]}
                                    onValueChange={(value) => {
                                      if (formData.ttsProvider === 'deepgram') {
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
                                  <SelectTrigger id="flow-voice" data-testid="select-flow-cve-voice">
                                    <SelectValue placeholder="Select Voice" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {customVoiceEngineVoices
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
                          <Select
                            value={formData.openaiVoice}
                            onValueChange={(value) => setFormData({ ...formData, openaiVoice: value })}
                          >
                            <SelectTrigger id="flow-voice" data-testid="select-flow-openai-voice">
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
                        ) : (
                          <div className="flex gap-2">
                            <div className="flex-1">
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
  );
}
