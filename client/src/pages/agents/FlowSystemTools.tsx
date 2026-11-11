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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface FlowSystemToolsProps {
  t: TFunction<"translation", undefined>;
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
}

export function FlowSystemTools({ t, formData, setFormData }: FlowSystemToolsProps) {
  return (
    <div className="space-y-4 border-t pt-4">
                          <div className="flex items-center">
                            <Label className="text-base">{t('agents.create.systemTools')}</Label>
                            <InfoTooltip content={t('agents.create.systemToolsTooltip')} />
                          </div>

                          {/* Language Detection Toggle */}
                          <label className="flex items-center gap-3 cursor-pointer" data-testid="label-flow-enable-language-detection">
                            <Checkbox
                              checked={formData.detectLanguageEnabled}
                              onCheckedChange={(checked) => setFormData({ ...formData, detectLanguageEnabled: checked as boolean })}
                              data-testid="checkbox-flow-enable-language-detection"
                            />
                            <div className="flex-1">
                              <div className="flex items-center gap-1">
                                <span className="text-sm font-medium">{t('agents.create.enableLanguageDetection')}</span>
                                <InfoTooltip content={t('agents.create.languageDetectionTooltip')} />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {t('agents.create.languageDetectionDescription')}
                              </p>
                            </div>
                          </label>
                        </div>
  );
}
