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
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface IncomingTemperatureFieldProps {
  t: TFunction<"translation", undefined>;
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
}

export function IncomingTemperatureField({ t, formData, setFormData }: IncomingTemperatureFieldProps) {
  return (
    <div className="space-y-2">
                        <div className="flex items-center">
                          <Label>{t('agents.create.temperature')}</Label>
                          <InfoTooltip content={(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? "OpenAI temperature (0-2): Higher values make output more random" : t('agents.create.temperatureTooltipFull')} />
                        </div>
                        <div className="space-y-4">
                          <Slider
                            min={0}
                            max={(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? 2 : 1}
                            step={0.1}
                            value={[formData.temperature]}
                            onValueChange={(value) => setFormData({ ...formData, temperature: value[0] })}
                            data-testid="slider-temperature"
                          />
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">{t('agents.create.current')}: {formData.temperature.toFixed(1)}</span>
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant={formData.temperature === 0.0 ? "default" : "outline"}
                                size="sm"
                                onClick={() => setFormData({ ...formData, temperature: 0.0 })}
                                data-testid="button-temp-deterministic"
                              >
                                {t('agents.create.deterministic')}
                              </Button>
                              <Button
                                type="button"
                                variant={formData.temperature === 0.5 ? "default" : "outline"}
                                size="sm"
                                onClick={() => setFormData({ ...formData, temperature: 0.5 })}
                                data-testid="button-temp-creative"
                              >
                                {t('agents.create.creative')}
                              </Button>
                              <Button
                                type="button"
                                variant={formData.temperature === 1.0 ? "default" : "outline"}
                                size="sm"
                                onClick={() => setFormData({ ...formData, temperature: 1.0 })}
                                data-testid="button-temp-more-creative"
                              >
                                {t('agents.create.moreCreative')}
                              </Button>
                              {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") && (
                                <Button
                                  type="button"
                                  variant={formData.temperature === 2.0 ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setFormData({ ...formData, temperature: 2.0 })}
                                  data-testid="button-temp-very-creative"
                                >
                                  Very Creative
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
  );
}
