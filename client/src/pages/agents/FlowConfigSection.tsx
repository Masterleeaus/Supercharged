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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Sparkles, Check, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { KnowledgeBaseItem, CVEEstimatedCost, AgentFormData } from "@/pages/agents/shared";

export interface FlowConfigSectionProps {
  t: TFunction<"translation", undefined>;
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
  openaiRealtimeModels: { id: string; modelId: string; name: string; tier: "free" | "pro"; description: string; }[];
  isOrModelsLoading: boolean;
  orModels: { id: string; name: string; context_length: number; }[];
  orSearch: string;
  setOrSearch: Dispatch<SetStateAction<string>>;
  availableLLMModels: { id: string; modelId: string; name: string; provider: string; tier: "free" | "pro"; isActive: boolean; }[];
  knowledgeBase: KnowledgeBaseItem[];
}

export function FlowConfigSection({ t, formData, setFormData, openaiRealtimeModels, isOrModelsLoading, orModels, orSearch, setOrSearch, availableLLMModels, knowledgeBase }: FlowConfigSectionProps) {
  return (
    <div className="space-y-4 border-t pt-4">
                        <Label className="text-base">{t('agents.create.agentConfiguration')}</Label>

                        {/* LLM Model for Flow Agents - Show OpenAI models for OpenAI-based engines */}
                        <div className="space-y-2">
                          <div className="flex items-center">
                            <Label htmlFor="flow-model">
                              {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? "OpenAI Model" : t('agents.create.llmModelRequired')} <span className="text-destructive">*</span>
                            </Label>
                            <InfoTooltip content={(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? "Select the OpenAI Realtime model for voice conversations" : t('agents.create.llmModelTooltip')} />
                          </div>
                          {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? (
                            <Select
                              value={formData.llmModel}
                              onValueChange={(value) => setFormData({ ...formData, llmModel: value })}
                            >
                              <SelectTrigger id="flow-model" data-testid="select-flow-model">
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
                              <SelectTrigger id="flow-model" data-testid="select-flow-model">
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
                              <SelectTrigger id="flow-model" data-testid="select-flow-model">
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
                            {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? "OpenAI Realtime models for low-latency voice AI" : t('agents.create.chooseModelFlow')}
                          </p>
                        </div>

                        {/* Temperature for Flow Agents - Extended range for OpenAI */}
                        <div className="space-y-2">
                          <div className="flex items-center">
                            <Label>{t('agents.create.temperature')}</Label>
                            <InfoTooltip content={(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? "OpenAI temperature (0-2): Higher values make output more random" : t('agents.create.temperatureTooltip')} />
                          </div>
                          <div className="space-y-4">
                            <Slider
                              min={0}
                              max={(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") ? 2 : 1}
                              step={0.1}
                              value={[formData.temperature]}
                              onValueChange={(value) => setFormData({ ...formData, temperature: value[0] })}
                              data-testid="slider-flow-temperature"
                            />
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">{t('agents.create.current')}: {formData.temperature.toFixed(1)}</span>
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  variant={formData.temperature === 0.0 ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setFormData({ ...formData, temperature: 0.0 })}
                                  data-testid="button-flow-temp-deterministic"
                                >
                                  {t('agents.create.deterministic')}
                                </Button>
                                <Button
                                  type="button"
                                  variant={formData.temperature === 0.5 ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setFormData({ ...formData, temperature: 0.5 })}
                                  data-testid="button-flow-temp-creative"
                                >
                                  {t('agents.create.creative')}
                                </Button>
                                <Button
                                  type="button"
                                  variant={formData.temperature === 1.0 ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setFormData({ ...formData, temperature: 1.0 })}
                                  data-testid="button-flow-temp-more-creative"
                                >
                                  {t('agents.create.moreCreative')}
                                </Button>
                                {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip") && (
                                  <Button
                                    type="button"
                                    variant={formData.temperature === 2.0 ? "default" : "outline"}
                                    size="sm"
                                    onClick={() => setFormData({ ...formData, temperature: 2.0 })}
                                    data-testid="button-flow-temp-very-creative"
                                  >
                                    Very Creative
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>

                        {formData.telephonyProvider === "custom-voice-engine" && (
                          <CVEEstimatedCost
                            sttProvider={formData.sttProvider}
                            sttModel={formData.sttModel}
                            ttsProvider={formData.ttsProvider}
                            ttsModel={formData.ttsModel}
                            llmModel={formData.llmModel}
                          />
                        )}

                        {/* System Prompt */}
                        <div className="space-y-2">
                          <div className="flex items-center">
                            <Label htmlFor="flow-system-prompt">{t('agents.create.systemPrompt')}</Label>
                            <InfoTooltip content={t('agents.create.systemPromptTooltip')} />
                          </div>
                          <Textarea
                            id="flow-system-prompt"
                            placeholder={t('agents.create.systemPromptPlaceholderFlow')}
                            value={formData.systemPrompt}
                            onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                            rows={4}
                            data-testid="input-flow-system-prompt"
                          />
                          <p className="text-xs text-muted-foreground">
                            {t('agents.create.systemPromptHint')}
                          </p>
                        </div>

                        {/* First Message */}
                        <div className="space-y-2">
                          <div className="flex items-center">
                            <Label htmlFor="flow-first-message">{t('agents.create.firstMessage')}</Label>
                            <InfoTooltip content={t('agents.create.firstMessageTooltip')} />
                          </div>
                          <Textarea
                            id="flow-first-message"
                            placeholder={t('agents.create.firstMessagePlaceholderFlow')}
                            value={formData.firstMessage}
                            onChange={(e) => setFormData({ ...formData, firstMessage: e.target.value })}
                            rows={2}
                            data-testid="input-flow-first-message"
                          />
                          <p className="text-xs text-muted-foreground">
                            {t('agents.create.firstMessageHint')}
                          </p>

                          {/* Dynamic Variables Helper for Flow Agents */}
                          <div className="mt-3 p-3 bg-muted/50 rounded-md border border-muted">
                            <p className="text-xs font-medium text-foreground mb-2">{t('agents.create.dynamicVariablesTitle')}</p>
                            <div className="flex flex-wrap gap-1.5 mb-2">
                              {['{{first_name}}', '{{last_name}}', '{{contact_name}}', '{{email}}', '{{phone}}', '{{city}}', '{{company}}'].map((variable) => (
                                <Badge
                                  key={variable}
                                  variant="secondary"
                                  className="text-xs font-mono cursor-pointer hover-elevate"
                                  onClick={() => {
                                    const textarea = document.getElementById('flow-first-message') as HTMLTextAreaElement;
                                    if (textarea) {
                                      const start = textarea.selectionStart;
                                      const end = textarea.selectionEnd;
                                      const newValue = formData.firstMessage.substring(0, start) + variable + formData.firstMessage.substring(end);
                                      setFormData({ ...formData, firstMessage: newValue });
                                    }
                                  }}
                                  data-testid={`badge-flow-variable-${variable.replace(/[{}]/g, '')}`}
                                >
                                  {variable}
                                </Badge>
                              ))}
                            </div>
                            <p className="text-xs text-muted-foreground">{t('agents.create.dynamicVariablesFromCSV')}</p>
                          </div>
                        </div>

                        {/* Knowledge Base */}
                        <div className="space-y-2">
                          <div className="flex items-center">
                            <Label>{t('agents.create.knowledgeBase')}</Label>
                            <InfoTooltip content={t('agents.create.knowledgeBaseTooltip')} />
                          </div>
                          <div className="border rounded-md p-4 max-h-48 overflow-y-auto space-y-2">
                            {knowledgeBase.length === 0 ? (
                              <p className="text-sm text-muted-foreground" data-testid="text-flow-no-knowledge-base">{t('agents.create.noKnowledgeItems')}</p>
                            ) : (
                              knowledgeBase.map((kb) => (
                                <label
                                  key={kb.id}
                                  className="flex items-center gap-2 cursor-pointer hover-elevate rounded-md p-2"
                                  data-testid={`label-flow-kb-${kb.id}`}
                                >
                                  <Checkbox
                                    checked={formData.knowledgeBaseIds.includes(kb.id)}
                                    onCheckedChange={(checked) => {
                                      if (checked) {
                                        setFormData({
                                          ...formData,
                                          knowledgeBaseIds: [...formData.knowledgeBaseIds, kb.id],
                                        });
                                      } else {
                                        setFormData({
                                          ...formData,
                                          knowledgeBaseIds: formData.knowledgeBaseIds.filter((id) => id !== kb.id),
                                        });
                                      }
                                    }}
                                    data-testid={`checkbox-flow-kb-${kb.id}`}
                                  />
                                  <span className="text-sm">{kb.title}</span>
                                </label>
                              ))
                            )}
                          </div>
                          {knowledgeBase.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              {t('agents.create.addKnowledgeHint')}
                            </p>
                          )}
                        </div>
                      </div>
  );
}
