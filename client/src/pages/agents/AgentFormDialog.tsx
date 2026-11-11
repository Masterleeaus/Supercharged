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
import { Mic, Brain } from "lucide-react";
import PromptTemplatesLibrary from "@/components/PromptTemplatesLibrary";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { Agent, Voice, KnowledgeBaseItem, CVEEstimatedCost } from "@/pages/agents/shared";
import { AgentFormSuccessOverlay } from "@/pages/agents/AgentFormSuccessOverlay";
import { AgentTypeSection } from "@/pages/agents/AgentTypeSection";
import { IncomingEngineFields } from "@/pages/agents/IncomingEngineFields";
import { FlowVoiceSettings } from "@/pages/agents/FlowVoiceSettings";
import { FlowSystemTools } from "@/pages/agents/FlowSystemTools";
import { FlowTelephonySection } from "@/pages/agents/FlowTelephonySection";
import { FlowVoiceSelection } from "@/pages/agents/FlowVoiceSelection";
import { FlowConfigSection } from "@/pages/agents/FlowConfigSection";
import { IncomingTelephonySection } from "@/pages/agents/IncomingTelephonySection";
import { IncomingVoiceSelection } from "@/pages/agents/IncomingVoiceSelection";
import { SystemToolsSection } from "@/pages/agents/SystemToolsSection";
import { IncomingLlmModelField } from "@/pages/agents/IncomingLlmModelField";
import { IncomingTemperatureField } from "@/pages/agents/IncomingTemperatureField";
import { IncomingVoiceFineTuning } from "@/pages/agents/IncomingVoiceFineTuning";
import { IncomingPromptFields } from "@/pages/agents/IncomingPromptFields";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

export interface AgentFormDialogProps {
  createDialogOpen: boolean;
  editingAgent: Agent;
  setCreateDialogOpen: Dispatch<SetStateAction<boolean>>;
  setEditingAgent: Dispatch<SetStateAction<Agent>>;
  resetForm: () => void;
  animationState: "idle" | "success" | "error";
  t: TFunction<"translation", undefined>;
  isCustomVoiceEngineEnabled: boolean;
  formData: { type: "incoming" | "flow" | "custom_engine"; name: string; voiceTone: string; personality: string; systemPrompt: string; elevenLabsVoiceId: string; language: string; llmModel: string; firstMessage: string; temperature: number; knowledgeBaseIds: string[]; transferNumber: string; transferKeywords: string[]; transferEnabled: boolean; transferPhoneNumber: string; detectLanguageEnabled: boolean; endConversationEnabled: boolean; appointmentBookingEnabled: boolean; messagingEmailEnabled: boolean; messagingWhatsappEnabled: boolean; messagingEmailTemplate: string; messagingWhatsappTemplate: string; messagingWhatsappVariables: string; expressiveMode: boolean; flowId: string; maxDurationSeconds: number; voiceStability: number; voiceSimilarityBoost: number; voiceSpeed: number; turnTimeout: number; telephonyProvider: "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine"; openaiVoice: string; sttProvider: string; sttModel: string; ttsProvider: string; ttsModel: string; sipPhoneNumberId: string; };
  setFormData: Dispatch<SetStateAction<{ type: "incoming" | "flow" | "custom_engine"; name: string; voiceTone: string; personality: string; systemPrompt: string; elevenLabsVoiceId: string; language: string; llmModel: string; firstMessage: string; temperature: number; knowledgeBaseIds: string[]; transferNumber: string; transferKeywords: string[]; transferEnabled: boolean; transferPhoneNumber: string; detectLanguageEnabled: boolean; endConversationEnabled: boolean; appointmentBookingEnabled: boolean; messagingEmailEnabled: boolean; messagingWhatsappEnabled: boolean; messagingEmailTemplate: string; messagingWhatsappTemplate: string; messagingWhatsappVariables: string; expressiveMode: boolean; flowId: string; maxDurationSeconds: number; voiceStability: number; voiceSimilarityBoost: number; voiceSpeed: number; turnTimeout: number; telephonyProvider: "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine"; openaiVoice: string; sttProvider: string; sttModel: string; ttsProvider: string; ttsModel: string; sipPhoneNumberId: string; }>>;
  flows: { id: string; name: string; description: string; }[];
  isV3TtsModel: boolean;
  hasAlternateEngines: boolean;
  availableLLMModels: { id: string; modelId: string; name: string; provider: string; tier: "free" | "pro"; isActive: boolean; }[];
  isTwilioOpenaiEnabled: boolean;
  isPlivoEnabled: boolean;
  isOpenAISipAllowed: boolean;
  allowedSttProviders: string[];
  currentSttAllowedModels: string[];
  allowedTtsProviders: string[];
  currentTtsAllowedModels: string[];
  openaiRealtimeModels: { id: string; modelId: string; name: string; tier: "free" | "pro"; description: string; }[];
  isOrModelsLoading: boolean;
  orModels: { id: string; name: string; context_length: number; }[];
  orSearch: string;
  setOrSearch: Dispatch<SetStateAction<string>>;
  knowledgeBase: KnowledgeBaseItem[];
  voices: Voice[];
  hasEmailTemplates: boolean;
  emailTemplates: { id: string; name: string; }[];
  isWhatsAppActive: boolean;
  whatsappTemplates: { name: string; id?: string; components?: any[]; }[];
  getWhatsAppTemplateVariables: (templateName: string) => number[];
  getWhatsAppTemplateButtonVariables: (templateName: string) => Array<{ index: number; label: string; url: string; }>;
  getWhatsAppTemplateHeaderInfo: (templateName: string) => { format: string; hasVariable: boolean; text?: string; } | null;
  parseWhatsAppVariables: (varsJson: string) => Record<string, { mode: "fixed" | "collect"; value: string; componentType?: string; }>;
  handleUpdate: () => void;
  handleCreate: () => void;
  createMutation: UseMutationResult<any, any, { type: "incoming" | "flow" | "custom_engine"; name: string; voiceTone: string; personality: string; systemPrompt: string; elevenLabsVoiceId: string; language: string; llmModel: string; firstMessage: string; temperature: number; knowledgeBaseIds: string[]; transferNumber: string; transferKeywords: string[]; transferEnabled: boolean; transferPhoneNumber: string; detectLanguageEnabled: boolean; endConversationEnabled: boolean; appointmentBookingEnabled: boolean; messagingEmailEnabled: boolean; messagingWhatsappEnabled: boolean; messagingEmailTemplate: string; messagingWhatsappTemplate: string; messagingWhatsappVariables: string; expressiveMode: boolean; flowId: string; maxDurationSeconds: number; voiceStability: number; voiceSimilarityBoost: number; voiceSpeed: number; turnTimeout: number; telephonyProvider: "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine"; openaiVoice: string; sttProvider: string; sttModel: string; ttsProvider: string; ttsModel: string; sipPhoneNumberId: string; }, unknown>;
  updateMutation: UseMutationResult<any, any, { id: string; data: Partial<{ type: "incoming" | "flow" | "custom_engine"; name: string; voiceTone: string; personality: string; systemPrompt: string; elevenLabsVoiceId: string; language: string; llmModel: string; firstMessage: string; temperature: number; knowledgeBaseIds: string[]; transferNumber: string; transferKeywords: string[]; transferEnabled: boolean; transferPhoneNumber: string; detectLanguageEnabled: boolean; endConversationEnabled: boolean; appointmentBookingEnabled: boolean; messagingEmailEnabled: boolean; messagingWhatsappEnabled: boolean; messagingEmailTemplate: string; messagingWhatsappTemplate: string; messagingWhatsappVariables: string; expressiveMode: boolean; flowId: string; maxDurationSeconds: number; voiceStability: number; voiceSimilarityBoost: number; voiceSpeed: number; turnTimeout: number; telephonyProvider: "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "custom-voice-engine"; openaiVoice: string; sttProvider: string; sttModel: string; ttsProvider: string; ttsModel: string; sipPhoneNumberId: string; }>; }, unknown>;
}

export function AgentFormDialog({ createDialogOpen, editingAgent, setCreateDialogOpen, setEditingAgent, resetForm, animationState, t, isCustomVoiceEngineEnabled, formData, setFormData, flows, isV3TtsModel, hasAlternateEngines, availableLLMModels, isTwilioOpenaiEnabled, isPlivoEnabled, isOpenAISipAllowed, allowedSttProviders, currentSttAllowedModels, allowedTtsProviders, currentTtsAllowedModels, openaiRealtimeModels, isOrModelsLoading, orModels, orSearch, setOrSearch, knowledgeBase, voices, hasEmailTemplates, emailTemplates, isWhatsAppActive, whatsappTemplates, getWhatsAppTemplateVariables, getWhatsAppTemplateButtonVariables, getWhatsAppTemplateHeaderInfo, parseWhatsAppVariables, handleUpdate, handleCreate, createMutation, updateMutation }: AgentFormDialogProps) {
  return (
    <Dialog open={createDialogOpen || !!editingAgent} onOpenChange={(open) => {
            if (!open) {
              setCreateDialogOpen(false);
              setEditingAgent(null);
              resetForm();
            }
          }}>
            <DialogContent className={`max-w-4xl flex flex-col max-h-[85vh] p-0 gap-0 overflow-hidden ${animationState === 'error' ? 'animate-shake' : ''}`}>
              {/* Success Animation Overlay */}
              {animationState === 'success' && (
                <AgentFormSuccessOverlay
                  editingAgent={editingAgent}
                  t={t}
                />
              )}

              {/* Fixed Header */}
              <DialogHeader className="px-6 pt-6 pb-4 border-b flex-shrink-0">
                <DialogTitle>{editingAgent ? t('agents.create.editTitle') : t('agents.create.title')}</DialogTitle>
                <DialogDescription>
                  {t('agents.create.dialogDescription')}
                </DialogDescription>
              </DialogHeader>

              {/* Scrollable Form Content */}
              <div className="flex-1 overflow-y-auto px-6">
                <div className="space-y-4 py-4">
                  {/* Agent Type Selector */}
                  <AgentTypeSection
                    t={t}
                    isCustomVoiceEngineEnabled={isCustomVoiceEngineEnabled}
                    formData={formData}
                    setFormData={setFormData}
                  />

                  {/* Agent Name - Common for both types */}
                  <div className="space-y-2">
                    <Label htmlFor="agent-name">
                      {t('agents.create.nameRequired')} <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="agent-name"
                      placeholder={formData.type === 'incoming' ? t('agents.create.incomingPlaceholder') : t('agents.create.flowPlaceholder')}
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      data-testid="input-agent-name"
                    />
                  </div>

                  {/* Incoming Agent Specific Fields - Voice & Personality */}
                  {(formData.type === 'incoming' || formData.type === 'custom_engine') && (
                    <IncomingEngineFields
                      t={t}
                      formData={formData}
                      setFormData={setFormData}
                    />
                  )}

                  {/* Flow Agent Specific Fields */}
                  {formData.type === 'flow' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center">
                          <Label htmlFor="flow-select">
                            {t('agents.create.conversationFlowRequired')} <span className="text-destructive">*</span>
                          </Label>
                          <InfoTooltip content={t('agents.create.conversationFlowTooltip')} />
                        </div>
                        <Select
                          value={formData.flowId}
                          onValueChange={(value) => setFormData({ ...formData, flowId: value })}
                        >
                          <SelectTrigger id="flow-select" data-testid="select-flow">
                            <SelectValue placeholder={t('agents.create.selectFlow')} />
                          </SelectTrigger>
                          <SelectContent>
                            {flows.length === 0 ? (
                              <SelectItem value="no-flows-available" disabled>{t('agents.create.noFlowsAvailable')}</SelectItem>
                            ) : (
                              flows.map((flow) => (
                                <SelectItem key={flow.id} value={flow.id}>
                                  {flow.name}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        {flows.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            {t('agents.create.createFlowFirst')}
                          </p>
                        )}
                      </div>

                      {/* Max Conversation Duration */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center">
                            <Label>{t('agents.create.maxConversationDuration')}</Label>
                            <InfoTooltip content={t('agents.create.maxDurationTooltip')} />
                          </div>
                          <span className="text-sm text-muted-foreground">{Math.round(formData.maxDurationSeconds / 60)} min</span>
                        </div>
                        <Slider
                          min={60}
                          max={1800}
                          step={60}
                          value={[formData.maxDurationSeconds]}
                          onValueChange={(value) => setFormData({ ...formData, maxDurationSeconds: value[0] })}
                          data-testid="slider-max-duration"
                        />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>1 min</span>
                          <span>30 min</span>
                        </div>
                      </div>

                      {/* Voice Settings for Flow Agents - Only show for ElevenLabs-based engines */}
                      {formData.telephonyProvider !== "plivo" && formData.telephonyProvider !== "twilio_openai" && formData.telephonyProvider !== "openai-sip" && formData.telephonyProvider !== "custom-voice-engine" && (
                        <FlowVoiceSettings
                          t={t}
                          isV3TtsModel={isV3TtsModel}
                          formData={formData}
                          setFormData={setFormData}
                        />
                      )}

                      {/* System Tools Section for Flow Agents - Only show for ElevenLabs-based engines */}
                      {formData.telephonyProvider !== "plivo" && formData.telephonyProvider !== "twilio_openai" && formData.telephonyProvider !== "openai-sip" && (
                        <FlowSystemTools
                          t={t}
                          formData={formData}
                          setFormData={setFormData}
                        />
                      )}

                      {/* Telephony Provider Selection for Flow Agents */}
                      {(hasAlternateEngines || formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai") && (
                        <FlowTelephonySection
                          formData={formData}
                          setFormData={setFormData}
                          availableLLMModels={availableLLMModels}
                          isTwilioOpenaiEnabled={isTwilioOpenaiEnabled}
                          isPlivoEnabled={isPlivoEnabled}
                          isOpenAISipAllowed={isOpenAISipAllowed}
                          isCustomVoiceEngineEnabled={isCustomVoiceEngineEnabled}
                        />
                      )}

                      {/* Note: SIP Phone Number selection is done at campaign level, not agent level */}

                      {/* Voice Selection for Flow Agents */}
                      <FlowVoiceSelection
                        t={t}
                        formData={formData}
                        allowedSttProviders={allowedSttProviders}
                        currentSttAllowedModels={currentSttAllowedModels}
                        setFormData={setFormData}
                        allowedTtsProviders={allowedTtsProviders}
                        currentTtsAllowedModels={currentTtsAllowedModels}
                      />

                      {/* Flow Agent Configuration Section */}
                      <FlowConfigSection
                        t={t}
                        formData={formData}
                        setFormData={setFormData}
                        openaiRealtimeModels={openaiRealtimeModels}
                        isOrModelsLoading={isOrModelsLoading}
                        orModels={orModels}
                        orSearch={orSearch}
                        setOrSearch={setOrSearch}
                        availableLLMModels={availableLLMModels}
                        knowledgeBase={knowledgeBase}
                      />
                    </div>
                  )}

                  {/* Voice & Language Section - Common for both types */}
                  <div className="flex items-center gap-2 pt-2">
                    <div className="h-8 w-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                      <Mic className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
                    </div>
                    <Label className="text-sm font-semibold text-cyan-700 dark:text-cyan-300">{t('agents.create.voiceLanguage')}</Label>
                  </div>

                  {/* Telephony Provider Selection - Show only for INCOMING agents if alternate engines are enabled */}
                  {(formData.type === 'incoming' || formData.type === 'custom_engine') && (hasAlternateEngines || formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai") && (
                    <IncomingTelephonySection
                      formData={formData}
                      setFormData={setFormData}
                      availableLLMModels={availableLLMModels}
                      isTwilioOpenaiEnabled={isTwilioOpenaiEnabled}
                      isPlivoEnabled={isPlivoEnabled}
                      isOpenAISipAllowed={isOpenAISipAllowed}
                      isCustomVoiceEngineEnabled={isCustomVoiceEngineEnabled}
                    />
                  )}

                  {/* Note: SIP Phone Number selection is done at campaign level, not agent level */}

                  <IncomingVoiceSelection
                    t={t}
                    formData={formData}
                    allowedSttProviders={allowedSttProviders}
                    currentSttAllowedModels={currentSttAllowedModels}
                    setFormData={setFormData}
                    allowedTtsProviders={allowedTtsProviders}
                    currentTtsAllowedModels={currentTtsAllowedModels}
                    voices={voices}
                  />

                  {/* Incoming Agent LLM and Prompt Configuration */}
                  {(formData.type === 'incoming' || formData.type === 'custom_engine') && (
                    <>
                      {/* AI Model Section Header */}
                      <div className="flex items-center gap-2 pt-2">
                        <div className="h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                          <Brain className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        </div>
                        <Label className="text-sm font-semibold text-amber-700 dark:text-amber-300">{t('agents.create.aiModelBehavior')}</Label>
                      </div>

                      {/* LLM Model for Incoming Agents - Show OpenAI models for OpenAI-based engines */}
                      <IncomingLlmModelField
                        formData={formData}
                        t={t}
                        setFormData={setFormData}
                        openaiRealtimeModels={openaiRealtimeModels}
                        isOrModelsLoading={isOrModelsLoading}
                        orModels={orModels}
                        orSearch={orSearch}
                        setOrSearch={setOrSearch}
                        availableLLMModels={availableLLMModels}
                      />

                      {/* Temperature for Incoming Agents - Extended range for OpenAI */}
                      <IncomingTemperatureField
                        t={t}
                        formData={formData}
                        setFormData={setFormData}
                      />

                      {formData.telephonyProvider === "custom-voice-engine" && (
                        <CVEEstimatedCost
                          sttProvider={formData.sttProvider}
                          sttModel={formData.sttModel}
                          ttsProvider={formData.ttsProvider}
                          ttsModel={formData.ttsModel}
                          llmModel={formData.llmModel}
                        />
                      )}

                      {/* Voice Fine-Tuning Section for Incoming Agents - Only show for ElevenLabs-based engines */}
                      {formData.telephonyProvider !== "plivo" && formData.telephonyProvider !== "twilio_openai" && formData.telephonyProvider !== "openai-sip" && formData.telephonyProvider !== "custom-voice-engine" && (
                        <IncomingVoiceFineTuning
                          t={t}
                          isV3TtsModel={isV3TtsModel}
                          formData={formData}
                          setFormData={setFormData}
                        />
                      )}

                      {formData.telephonyProvider !== "custom-voice-engine" && (
                        <PromptTemplatesLibrary
                          mode="select"
                          onSelectTemplate={(template) => {
                            setFormData({
                              ...formData,
                              systemPrompt: template.systemPrompt,
                              firstMessage: template.firstMessage || formData.firstMessage,
                              voiceTone: template.suggestedVoiceTone || formData.voiceTone,
                              personality: template.suggestedPersonality || formData.personality,
                            });
                          }}
                        />
                      )}

                      <IncomingPromptFields
                        t={t}
                        formData={formData}
                        setFormData={setFormData}
                      />

                      <div className="space-y-2">
                        <div className="flex items-center">
                          <Label htmlFor="first-message">{t('agents.create.firstMessage')}</Label>
                          <InfoTooltip content={t('agents.create.firstMessageTooltipFull')} />
                        </div>
                        <Textarea
                          id="first-message"
                          placeholder={t('agents.create.firstMessagePlaceholder')}
                          value={formData.firstMessage}
                          onChange={(e) => setFormData({ ...formData, firstMessage: e.target.value })}
                          rows={2}
                          data-testid="input-first-message"
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('agents.create.firstMessageTip')}
                        </p>

                        {/* Dynamic Variables Helper */}
                        <div className="mt-3 p-3 bg-muted/50 rounded-md border border-muted">
                          <p className="text-xs font-medium text-foreground mb-2">{t('agents.create.dynamicVariablesTitle')}</p>
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {['{{first_name}}', '{{last_name}}', '{{contact_name}}', '{{email}}', '{{phone}}', '{{city}}', '{{company}}'].map((variable) => (
                              <Badge
                                key={variable}
                                variant="secondary"
                                className="text-xs font-mono cursor-pointer hover-elevate"
                                onClick={() => {
                                  const textarea = document.getElementById('first-message') as HTMLTextAreaElement;
                                  if (textarea) {
                                    const start = textarea.selectionStart;
                                    const end = textarea.selectionEnd;
                                    const newValue = formData.firstMessage.substring(0, start) + variable + formData.firstMessage.substring(end);
                                    setFormData({ ...formData, firstMessage: newValue });
                                  }
                                }}
                                data-testid={`badge-variable-${variable.replace(/[{}]/g, '')}`}
                              >
                                {variable}
                              </Badge>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">{t('agents.create.dynamicVariablesFromCSV')}</p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center">
                          <Label>{t('agents.create.knowledgeBase')}</Label>
                          <InfoTooltip content={t('agents.create.knowledgeBaseTooltipFull')} />
                        </div>
                        <div className="border rounded-md p-4 max-h-48 overflow-y-auto space-y-2">
                          {knowledgeBase.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t('agents.create.noKnowledgeItems')}</p>
                          ) : (
                            knowledgeBase.map((kb) => (
                              <label
                                key={kb.id}
                                className="flex items-center gap-2 cursor-pointer hover-elevate rounded-md p-2"
                                data-testid={`label-kb-${kb.id}`}
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
                                        knowledgeBaseIds: formData.knowledgeBaseIds.filter(id => id !== kb.id),
                                      });
                                    }
                                  }}
                                  data-testid={`checkbox-kb-${kb.id}`}
                                />
                                <span className="text-sm">{kb.title}</span>
                              </label>
                            ))
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('agents.create.selectKnowledgeHint')}
                        </p>
                      </div>

                      {/* System Tools Section - Now for ALL Agent types (Incoming and Flow) */}
                      {['incoming', 'flow', 'custom_engine'].includes(formData.type) && (
                        <SystemToolsSection
                          t={t}
                          formData={formData}
                          setFormData={setFormData}
                          hasEmailTemplates={hasEmailTemplates}
                          emailTemplates={emailTemplates}
                          isWhatsAppActive={isWhatsAppActive}
                          whatsappTemplates={whatsappTemplates}
                          getWhatsAppTemplateVariables={getWhatsAppTemplateVariables}
                          getWhatsAppTemplateButtonVariables={getWhatsAppTemplateButtonVariables}
                          getWhatsAppTemplateHeaderInfo={getWhatsAppTemplateHeaderInfo}
                          parseWhatsAppVariables={parseWhatsAppVariables}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Fixed Footer */}
              <div className="flex justify-end gap-2 px-6 py-4 border-t flex-shrink-0">
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreateDialogOpen(false);
                    setEditingAgent(null);
                    resetForm();
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  onClick={editingAgent ? handleUpdate : handleCreate}
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="button-save-agent"
                >
                  {createMutation.isPending || updateMutation.isPending
                    ? t('common.saving')
                    : editingAgent
                      ? t('agents.create.updateAgent')
                      : t('agents.create.createAgent')}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
  );
}
