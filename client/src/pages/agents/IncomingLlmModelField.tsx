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
import { Input } from "@/components/ui/input";
import { Sparkles, Check, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface IncomingLlmModelFieldProps {
  formData: AgentFormData;
  t: TFunction<"translation", undefined>;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
  openaiRealtimeModels: { id: string; modelId: string; name: string; tier: "free" | "pro"; description: string; }[];
  isOrModelsLoading: boolean;
  orModels: { id: string; name: string; context_length: number; }[];
  orSearch: string;
  setOrSearch: Dispatch<SetStateAction<string>>;
  availableLLMModels: { id: string; modelId: string; name: string; provider: string; tier: "free" | "pro"; isActive: boolean; }[];
}

export function IncomingLlmModelField({ formData, t, setFormData, openaiRealtimeModels, isOrModelsLoading, orModels, orSearch, setOrSearch, availableLLMModels }: IncomingLlmModelFieldProps) {
  return (
    <div className="space-y-2">
                        <div className="flex items-center">
                          <Label htmlFor="model">
                            {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? "OpenAI Model" : t('agents.create.llmModelRequired')} <span className="text-destructive">*</span>
                          </Label>
                          <InfoTooltip content={(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? "Select the OpenAI Realtime model for voice conversations" : t('agents.create.llmModelTooltip')} />
                        </div>
                        {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? (
                          <Select
                            value={formData.llmModel}
                            onValueChange={(value) => setFormData({ ...formData, llmModel: value })}
                          >
                            <SelectTrigger id="model" data-testid="select-model">
                              <SelectValue placeholder={openaiRealtimeModels.length === 0 ? "Loading models..." : "Select OpenAI model"} />
                            </SelectTrigger>
                            <SelectContent>
                              {openaiRealtimeModels.length === 0 ? (
                                <SelectItem value="gpt-realtime-1.5">
                                  GPT Realtime 1.5 (Default)
                                </SelectItem>
                              ) : (
                                openaiRealtimeModels.map((model) => (
                                  <SelectItem key={model.id} value={model.modelId}>
                                    <div className="flex items-center gap-2">
                                      <span>{model.name}</span>
                                      {model.tier === 'free' ? (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                          <Check className="h-3 w-3" />
                                          {t('agents.create.free')}
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gradient-to-r from-violet-500/20 to-purple-500/20 text-violet-700 dark:text-violet-300 border border-violet-300/50 dark:border-violet-500/30">
                                          <Sparkles className="h-3 w-3" />
                                          {t('agents.create.pro')}
                                        </span>
                                      )}
                                    </div>
                                  </SelectItem>
                                ))
                              )}
                            </SelectContent>
                          </Select>
                         ) : formData.telephonyProvider === "custom-voice-engine" ? (
                            <Select
                              value={formData.llmModel}
                              onValueChange={(value) => setFormData({ ...formData, llmModel: value })}
                            >
                              <SelectTrigger id="model" data-testid="select-model">
                                {isOrModelsLoading ? (
                                  <span className="flex items-center gap-2 text-muted-foreground">
                                    <Loader2 className="h-3 w-3 animate-spin" /> Loading models...
                                  </span>
                                ) : formData.llmModel ? (
                                  <span>
                                    {orModels.find(m => m.id === formData.llmModel)?.name || 
                                     (formData.llmModel.includes("/") ? formData.llmModel.split("/").pop() : formData.llmModel)}
                                  </span>
                                ) : (
                                  <SelectValue placeholder="Select a model" />
                                )}
                              </SelectTrigger>
                              <SelectContent className="max-h-[320px]">
                                <div className="px-2 py-1.5 sticky top-0 z-10 bg-popover border-b">
                                  <Input
                                    placeholder="Search models..."
                                    value={orSearch}
                                    onChange={(e) => setOrSearch(e.target.value)}
                                    className="h-7 text-xs"
                                    onKeyDown={(e) => e.stopPropagation()}
                                  />
                                </div>
                                {isOrModelsLoading ? (
                                  <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground text-xs">
                                    <Loader2 className="h-4 w-4 animate-spin" /> Fetching from OpenRouter...
                                  </div>
                                ) : orModels.length > 0 ? (
                                  orModels
                                    .filter((m) =>
                                      m.name.toLowerCase().includes(orSearch.toLowerCase()) ||
                                      m.id.toLowerCase().includes(orSearch.toLowerCase())
                                    )
                                    .slice(0, 80)
                                    .map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        <div className="flex flex-col py-0.5">
                                          <span className="text-xs font-medium leading-tight">{m.name}</span>
                                          <span className="text-[10px] text-muted-foreground font-mono leading-tight">{m.id}</span>
                                        </div>
                                      </SelectItem>
                                    ))
                                ) : (
                                  <>
                                    <SelectItem value="openai/gpt-4o-mini">GPT-4o Mini</SelectItem>
                                    <SelectItem value="openai/gpt-4o">GPT-4o</SelectItem>
                                    <SelectItem value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</SelectItem>
                                  </>
                                )}
                              </SelectContent>
                            </Select>
                          ) : (
                          <Select
                            value={formData.llmModel}
                            onValueChange={(value) => setFormData({ ...formData, llmModel: value })}
                          >
                            <SelectTrigger id="model" data-testid="select-model">
                              <SelectValue placeholder={availableLLMModels.length === 0 ? t('agents.create.noModelsAvailable') : t('agents.create.selectAModel')} />
                            </SelectTrigger>
                            <SelectContent>
                              {availableLLMModels.length === 0 ? (
                                <SelectItem value="no-models" disabled>
                                  {t('agents.create.noModelsAvailable')}
                                </SelectItem>
                              ) : (
                                availableLLMModels.map((model) => (
                                  <SelectItem key={model.id} value={model.modelId}>
                                    <div className="flex items-center gap-2">
                                      <span>{model.name}</span>
                                      {model.tier === 'free' ? (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                          <Check className="h-3 w-3" />
                                          {t('agents.create.free')}
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gradient-to-r from-violet-500/20 to-purple-500/20 text-violet-700 dark:text-violet-300 border border-violet-300/50 dark:border-violet-500/30">
                                          <Sparkles className="h-3 w-3" />
                                          {t('agents.create.pro')}
                                        </span>
                                      )}
                                    </div>
                                  </SelectItem>
                                ))
                              )}
                            </SelectContent>
                          </Select>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? "OpenAI Realtime models for low-latency voice AI" : t('agents.create.chooseModel')}
                        </p>
                      </div>
  );
}
