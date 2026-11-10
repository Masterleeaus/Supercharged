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
import { Textarea } from "@/components/ui/textarea";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface IncomingPromptFieldsProps {
  t: TFunction<"translation", undefined>;
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
}

export function IncomingPromptFields({ t, formData, setFormData }: IncomingPromptFieldsProps) {
  return (
    <div className="space-y-2">
                        <div className="flex items-center">
                          <Label htmlFor="system-prompt">
                            {t('agents.create.systemPromptRequired')} <span className="text-destructive">*</span>
                          </Label>
                          <InfoTooltip content={t('agents.create.systemPromptTooltipFull')} />
                        </div>
                        <Textarea
                          id="system-prompt"
                          placeholder={t('agents.create.systemPromptPlaceholder')}
                          value={formData.systemPrompt}
                          onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                          rows={8}
                          data-testid="input-system-prompt"
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('agents.create.systemPromptTip')}
                        </p>
                      </div>
  );
}
