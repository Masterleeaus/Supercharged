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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Sparkles, Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface FlowVoiceSettingsProps {
  t: TFunction<"translation", undefined>;
  isV3TtsModel: boolean;
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
}

export function FlowVoiceSettings({ t, isV3TtsModel, formData, setFormData }: FlowVoiceSettingsProps) {
  return (
    <div className="space-y-3 border-t pt-4">
                          <Label className="text-base">{t('agents.create.voiceFineTuning')}</Label>

                          {isV3TtsModel ? (
                            <div className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg" data-testid="info-v3-voice-settings-natural">
                              <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                              <p className="text-xs text-muted-foreground">
                                {t('agents.create.v3VoiceNote', 'V3 Conversational model automatically optimizes voice quality. Use Expressive Mode and audio tags to control how the agent sounds.')}
                              </p>
                            </div>
                          ) : (
                            <>
                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center">
                                    <Label>{t('agents.create.stability')}</Label>
                                    <InfoTooltip content={t('agents.create.stabilityTooltip')} />
                                  </div>
                                  <span className="text-sm text-muted-foreground">{Math.round(formData.voiceStability * 100)}%</span>
                                </div>
                                <Slider
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  value={[formData.voiceStability]}
                                  onValueChange={(value) => setFormData({ ...formData, voiceStability: value[0] })}
                                  data-testid="slider-voice-stability"
                                />
                              </div>

                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center">
                                    <Label>{t('agents.create.similarityBoost')}</Label>
                                    <InfoTooltip content={t('agents.create.similarityBoostTooltip')} />
                                  </div>
                                  <span className="text-sm text-muted-foreground">{Math.round(formData.voiceSimilarityBoost * 100)}%</span>
                                </div>
                                <Slider
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  value={[formData.voiceSimilarityBoost]}
                                  onValueChange={(value) => setFormData({ ...formData, voiceSimilarityBoost: value[0] })}
                                  data-testid="slider-voice-similarity"
                                />
                              </div>

                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center">
                                    <Label>{t('agents.create.speechSpeed')}</Label>
                                    <InfoTooltip content={t('agents.create.speechSpeedTooltip')} />
                                  </div>
                                  <span className="text-sm text-muted-foreground">{formData.voiceSpeed.toFixed(2)}x</span>
                                </div>
                                <Slider
                                  min={0.7}
                                  max={1.2}
                                  step={0.05}
                                  value={[formData.voiceSpeed]}
                                  onValueChange={(value) => setFormData({ ...formData, voiceSpeed: value[0] })}
                                  data-testid="slider-voice-speed"
                                />
                              </div>
                            </>
                          )}

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center">
                                <Label>{t('agents.create.responseDelay', 'Response Delay')}</Label>
                                <InfoTooltip content={t('agents.create.responseDelayTooltip', 'How long the agent waits after the caller stops speaking before responding. Lower values make the agent respond faster, higher values give more natural pauses.')} />
                              </div>
                              <span className="text-sm text-muted-foreground">{formData.turnTimeout.toFixed(1)}s</span>
                            </div>
                            <Slider
                              min={0.5}
                              max={5.0}
                              step={0.1}
                              value={[formData.turnTimeout]}
                              onValueChange={(value) => setFormData({ ...formData, turnTimeout: value[0] })}
                              data-testid="slider-natural-turn-timeout"
                            />
                          </div>

                          <div className="border-t pt-3 mt-3">
                            <label className="flex items-center gap-3 cursor-pointer" data-testid="label-flow-expressive-mode">
                              <Checkbox
                                checked={formData.expressiveMode}
                                onCheckedChange={(checked) => setFormData({ ...formData, expressiveMode: checked as boolean })}
                                data-testid="checkbox-flow-expressive-mode"
                              />
                              <div className="flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium">{t('agents.create.expressiveMode')}</span>
                                  <Badge variant="secondary" className="text-[10px] no-default-hover-elevate no-default-active-elevate">
                                    <Sparkles className="h-2.5 w-2.5 mr-0.5" />
                                    {t('common.new', 'New')}
                                  </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground">{t('agents.create.expressiveModeDesc')}</p>
                              </div>
                            </label>
                          </div>
                        </div>
  );
}
