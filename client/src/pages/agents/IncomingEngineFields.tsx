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
import { Mic } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface IncomingEngineFieldsProps {
  t: TFunction<"translation", undefined>;
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
}

export function IncomingEngineFields({ t, formData, setFormData }: IncomingEngineFieldsProps) {
  return (
    <>
                      {/* Voice & Personality Section Header */}
                      <div className="flex items-center gap-2 pt-2">
                        <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                          <Mic className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                        </div>
                        <Label className="text-sm font-semibold text-blue-700 dark:text-blue-300">{t('agents.create.voicePersonality')}</Label>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <div className="flex items-center">
                            <Label htmlFor="voice-tone">{t('agents.create.voiceTone')}</Label>
                            <InfoTooltip content={t('agents.create.voiceToneTooltip')} />
                          </div>
                          <Select
                            value={formData.voiceTone}
                            onValueChange={(value) => setFormData({ ...formData, voiceTone: value })}
                          >
                            <SelectTrigger id="voice-tone" data-testid="select-voice-tone">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="professional">{t('agents.voiceTones.professional')}</SelectItem>
                              <SelectItem value="friendly">{t('agents.voiceTones.friendly')}</SelectItem>
                              <SelectItem value="casual">{t('agents.voiceTones.casual')}</SelectItem>
                              <SelectItem value="formal">{t('agents.voiceTones.formal')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center">
                            <Label htmlFor="personality">{t('agents.create.personality')}</Label>
                            <InfoTooltip content={t('agents.create.personalityTooltip')} />
                          </div>
                          <Select
                            value={formData.personality}
                            onValueChange={(value) => setFormData({ ...formData, personality: value })}
                          >
                            <SelectTrigger id="personality" data-testid="select-personality">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="helpful">{t('agents.personalities.helpful')}</SelectItem>
                              <SelectItem value="enthusiastic">{t('agents.personalities.enthusiastic')}</SelectItem>
                              <SelectItem value="empathetic">{t('agents.personalities.empathetic')}</SelectItem>
                              <SelectItem value="direct">{t('agents.personalities.direct')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </>
  );
}
