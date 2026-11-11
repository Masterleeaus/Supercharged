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
import { Bot, Sparkles, GitBranch } from "lucide-react";
import { Label } from "@/components/ui/label";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface AgentTypeSectionProps {
  t: TFunction<"translation", undefined>;
  isCustomVoiceEngineEnabled: boolean;
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
}

export function AgentTypeSection({ t, isCustomVoiceEngineEnabled, formData, setFormData }: AgentTypeSectionProps) {
  return (
    <div className="space-y-3">
                    <Label className="text-base font-semibold">{t('agents.create.typeRequired')} <span className="text-destructive">*</span></Label>
                    <div className={`grid gap-4 ${isCustomVoiceEngineEnabled ? "grid-cols-3" : "grid-cols-2"}`}>
                      <div
                        className={`relative p-4 rounded-xl cursor-pointer transition-all duration-200 ${formData.type === 'incoming'
                          ? 'bg-gradient-to-br from-emerald-500/20 via-emerald-400/10 to-brand/20 dark:from-emerald-500/30 dark:via-emerald-400/15 dark:to-brand/25 border-2 border-emerald-500/50 shadow-lg shadow-emerald-500/10'
                          : 'bg-muted/30 hover:bg-muted/50 border-2 border-transparent hover:border-border'
                          }`}
                        onClick={() => setFormData({ 
                          ...formData, 
                          type: 'incoming', 
                          telephonyProvider: formData.telephonyProvider === "custom-voice-engine" ? "twilio" : formData.telephonyProvider 
                        })}
                        data-testid="card-type-incoming"
                      >
                        <div className="flex items-start gap-3">
                          <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${formData.type === 'incoming'
                            ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                            : 'bg-muted text-muted-foreground'
                            }`}>
                            <Sparkles className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className={`font-semibold ${formData.type === 'incoming' ? 'text-emerald-700 dark:text-emerald-300' : ''}`}>{t('agents.create.incomingAgent')}</h4>
                              {formData.type === 'incoming' && (
                                <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {t('agents.create.incomingDescription')}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div
                        className={`relative p-4 rounded-xl cursor-pointer transition-all duration-200 ${formData.type === 'flow'
                          ? 'bg-gradient-to-br from-violet-500/20 via-purple-400/10 to-indigo-500/20 dark:from-violet-500/30 dark:via-purple-400/15 dark:to-indigo-500/25 border-2 border-violet-500/50 shadow-lg shadow-violet-500/10'
                          : 'bg-muted/30 hover:bg-muted/50 border-2 border-transparent hover:border-border'
                          }`}
                        onClick={() => setFormData({ 
                          ...formData, 
                          type: 'flow', 
                          telephonyProvider: formData.telephonyProvider === "custom-voice-engine" ? "twilio" : formData.telephonyProvider 
                        })}
                        data-testid="card-type-flow"
                      >
                        <div className="flex items-start gap-3">
                          <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${formData.type === 'flow'
                            ? 'bg-violet-500/20 text-violet-600 dark:text-violet-400'
                            : 'bg-muted text-muted-foreground'
                            }`}>
                            <GitBranch className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className={`font-semibold ${formData.type === 'flow' ? 'text-violet-700 dark:text-violet-300' : ''}`}>{t('agents.create.flowAgent')}</h4>
                              {formData.type === 'flow' && (
                                <div className="h-2 w-2 rounded-full bg-violet-500 animate-pulse" />
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {t('agents.create.flowDescription')}
                            </p>
                          </div>
                        </div>
                      </div>

                      {isCustomVoiceEngineEnabled && (
                        <div
                          className={`relative p-4 rounded-xl cursor-pointer transition-all duration-200 ${formData.type === 'custom_engine'
                            ? 'bg-gradient-to-br from-indigo-500/20 via-indigo-400/10 to-brand/20 dark:from-indigo-500/30 dark:via-indigo-400/15 dark:to-indigo-500/25 border-2 border-indigo-500/50 shadow-lg shadow-indigo-500/10'
                            : 'bg-muted/30 hover:bg-muted/50 border-2 border-transparent hover:border-border'
                            }`}
                          onClick={() => setFormData({ 
                            ...formData, 
                            type: 'custom_engine', 
                            telephonyProvider: "custom-voice-engine" 
                          })}
                          data-testid="card-type-custom-engine"
                        >
                          <div className="flex items-start gap-3">
                            <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${formData.type === 'custom_engine'
                              ? 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-400'
                              : 'bg-muted text-muted-foreground'
                              }`}>
                              <Bot className="h-5 w-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <h4 className={`font-semibold ${formData.type === 'custom_engine' ? 'text-indigo-700 dark:text-indigo-300' : ''}`}>Custom Engine Agent</h4>
                                {formData.type === 'custom_engine' && (
                                  <div className="h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                Self-hosted FreeSWITCH pipeline supporting both incoming calls on SIP trunks and outgoing automated campaigns.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
  );
}
