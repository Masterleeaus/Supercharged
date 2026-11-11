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
import { Checkbox } from "@/components/ui/checkbox";
import { Wrench } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface SystemToolsSectionProps {
  t: TFunction<"translation", undefined>;
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
  hasEmailTemplates: boolean;
  emailTemplates: { id: string; name: string; }[];
  isWhatsAppActive: boolean;
  whatsappTemplates: { name: string; id?: string; components?: any[]; }[];
  getWhatsAppTemplateVariables: (templateName: string) => number[];
  getWhatsAppTemplateButtonVariables: (templateName: string) => Array<{ index: number; label: string; url: string; }>;
  getWhatsAppTemplateHeaderInfo: (templateName: string) => { format: string; hasVariable: boolean; text?: string; } | null;
  parseWhatsAppVariables: (varsJson: string) => Record<string, { mode: "fixed" | "collect"; value: string; componentType?: string; }>;
}

export function SystemToolsSection({ t, formData, setFormData, hasEmailTemplates, emailTemplates, isWhatsAppActive, whatsappTemplates, getWhatsAppTemplateVariables, getWhatsAppTemplateButtonVariables, getWhatsAppTemplateHeaderInfo, parseWhatsAppVariables }: SystemToolsSectionProps) {
  return (
    <div className="space-y-4 pt-4">
                          {/* System Tools Section Header */}
                          <div className="flex items-center gap-2">
                            <div className="h-8 w-8 rounded-lg bg-rose-500/10 flex items-center justify-center">
                              <Wrench className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                            </div>
                            <div className="flex items-center gap-1">
                              <Label className="text-sm font-semibold text-rose-700 dark:text-rose-300">{t('agents.create.systemTools')}</Label>
                              <InfoTooltip content={t('agents.systemTools.description')} />
                            </div>
                          </div>

                          {/* Call Transfer Toggle */}
                          <div className="space-y-3">
                            <label className="flex items-center gap-3 cursor-pointer" data-testid="label-enable-transfer">
                              <Checkbox
                                checked={formData.transferEnabled}
                                onCheckedChange={(checked) => setFormData({ ...formData, transferEnabled: checked as boolean })}
                                data-testid="checkbox-enable-transfer"
                              />
                              <div className="flex-1">
                                <div className="flex items-center gap-1">
                                  <span className="text-sm font-medium">{t('agents.systemTools.enableCallTransfer')}</span>
                                  <InfoTooltip content={t('agents.systemTools.callTransferTooltip')} />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {t('agents.systemTools.callTransferDescription')}
                                </p>
                              </div>
                            </label>

                            {formData.transferEnabled && (
                              <div className="ml-7 space-y-2">
                                <Label htmlFor="transfer-phone" className="text-sm font-normal">
                                  {t('agents.systemTools.transferPhoneNumber')} <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                  id="transfer-phone"
                                  placeholder="+1234567890"
                                  value={formData.transferPhoneNumber}
                                  onChange={(e) => setFormData({ ...formData, transferPhoneNumber: e.target.value })}
                                  data-testid="input-transfer-phone"
                                />
                                <p className="text-xs text-muted-foreground">
                                  {t('agents.systemTools.transferPhoneHint')}
                                </p>
                              </div>
                            )}
                          </div>

                          {/* Language Detection Toggle - All engines support this */}
                          <label className="flex items-center gap-3 cursor-pointer" data-testid="label-enable-language-detection">
                            <Checkbox
                              checked={formData.detectLanguageEnabled}
                              onCheckedChange={(checked) => setFormData({ ...formData, detectLanguageEnabled: checked as boolean })}
                              data-testid="checkbox-enable-language-detection"
                            />
                            <div className="flex-1">
                              <div className="flex items-center gap-1">
                                <span className="text-sm font-medium">{t('agents.create.enableLanguageDetection')}</span>
                                <InfoTooltip content={t('agents.systemTools.languageDetectionTooltip')} />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {t('agents.systemTools.languageDetectionDescription')}
                              </p>
                            </div>
                          </label>

                          {/* End Conversation Toggle - All engines support this */}
                          <label className="flex items-center gap-3 cursor-pointer" data-testid="label-enable-end-conversation">
                            <Checkbox
                              checked={formData.endConversationEnabled}
                              onCheckedChange={(checked) => setFormData({ ...formData, endConversationEnabled: checked as boolean })}
                              data-testid="checkbox-enable-end-conversation"
                            />
                            <div className="flex-1">
                              <div className="flex items-center gap-1">
                                <span className="text-sm font-medium">{t('agents.systemTools.enableEndConversation')}</span>
                                <InfoTooltip content={t('agents.systemTools.endConversationTooltip')} />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {t('agents.systemTools.endConversationDescription')}
                              </p>
                            </div>
                          </label>

                          {/* Appointment Booking Toggle - Supported for all agent types */}
                          {['incoming', 'flow', 'custom_engine'].includes(formData.type) && (
                            <label className="flex items-center gap-3 cursor-pointer" data-testid="label-enable-appointment-booking">
                              <Checkbox
                                checked={formData.appointmentBookingEnabled}
                                onCheckedChange={(checked) => setFormData({ ...formData, appointmentBookingEnabled: checked as boolean })}
                                data-testid="checkbox-enable-appointment-booking"
                              />
                              <div className="flex-1">
                                <div className="flex items-center gap-1">
                                  <span className="text-sm font-medium">{t('agents.systemTools.enableAppointmentBooking')}</span>
                                  <InfoTooltip content={t('agents.systemTools.appointmentBookingTooltip')} />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {t('agents.systemTools.appointmentBookingDescription')}
                                </p>
                              </div>
                            </label>
                          )}

                          {hasEmailTemplates && (
                            <div className="space-y-2">
                              <label className="flex items-center gap-3 cursor-pointer" data-testid="label-enable-messaging-email">
                                <Checkbox
                                  checked={formData.messagingEmailEnabled}
                                  onCheckedChange={(checked) => setFormData({ ...formData, messagingEmailEnabled: checked as boolean, messagingEmailTemplate: checked ? formData.messagingEmailTemplate : "" })}
                                  data-testid="checkbox-enable-messaging-email"
                                />
                                <div className="flex-1">
                                  <div className="flex items-center gap-1">
                                    <span className="text-sm font-medium">{t('agents.systemTools.enableMessagingEmail', 'Enable Email Sending')}</span>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {t('agents.systemTools.messagingEmailDescription', 'Allow this agent to send emails to callers using your email templates.')}
                                  </p>
                                </div>
                              </label>
                              {formData.messagingEmailEnabled && (
                                <div className="ml-8">
                                  <Label className="text-xs text-muted-foreground mb-1 block">{t('agents.systemTools.selectEmailTemplate', 'Select Email Template')} <span className="text-destructive">*</span></Label>
                                  <Select
                                    value={formData.messagingEmailTemplate}
                                    onValueChange={(value) => setFormData({ ...formData, messagingEmailTemplate: value })}
                                  >
                                    <SelectTrigger data-testid="select-email-template">
                                      <SelectValue placeholder={t('agents.systemTools.selectTemplatePlaceholder', 'Choose a template...')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {emailTemplates.map((template) => (
                                        <SelectItem key={template.id || template.name} value={template.name} data-testid={`select-email-template-${template.name}`}>
                                          {template.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )}
                            </div>
                          )}

                          {isWhatsAppActive && (
                            <div className="space-y-2">
                              <label className="flex items-center gap-3 cursor-pointer" data-testid="label-enable-messaging-whatsapp">
                                <Checkbox
                                  checked={formData.messagingWhatsappEnabled}
                                  onCheckedChange={(checked) => setFormData({ ...formData, messagingWhatsappEnabled: checked as boolean, messagingWhatsappTemplate: checked ? formData.messagingWhatsappTemplate : "" })}
                                  data-testid="checkbox-enable-messaging-whatsapp"
                                />
                                <div className="flex-1">
                                  <div className="flex items-center gap-1">
                                    <span className="text-sm font-medium">{t('agents.systemTools.enableMessagingWhatsapp', 'Enable WhatsApp Sending')}</span>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {t('agents.systemTools.messagingWhatsappDescription', 'Allow this agent to send WhatsApp messages to callers via WhatsWay.')}
                                  </p>
                                </div>
                              </label>
                              {formData.messagingWhatsappEnabled && whatsappTemplates.length > 0 ? (
                                <div className="ml-8 space-y-3">
                                  <div>
                                    <Label className="text-xs text-muted-foreground mb-1 block">{t('agents.systemTools.selectWhatsappTemplate', 'Select WhatsApp Template')} <span className="text-destructive">*</span></Label>
                                    <Select
                                      value={formData.messagingWhatsappTemplate}
                                      onValueChange={(value) => {
                                        const varIndices = getWhatsAppTemplateVariables(value);
                                        const buttonVars = getWhatsAppTemplateButtonVariables(value);
                                        const headerInfo = getWhatsAppTemplateHeaderInfo(value);
                                        const existingVars = parseWhatsAppVariables(formData.messagingWhatsappVariables);
                                        const newVars: Record<string, { mode: 'fixed' | 'collect'; value: string; componentType?: string }> = {};
                                        varIndices.forEach(idx => {
                                          newVars[String(idx)] = existingVars[String(idx)] || { mode: 'collect', value: '' };
                                        });
                                        buttonVars.forEach(btn => {
                                          const key = `btn_${btn.index}`;
                                          newVars[key] = existingVars[key] || { mode: 'fixed', value: '', componentType: 'button' };
                                        });
                                        if (headerInfo?.hasVariable) {
                                          newVars['header_value'] = existingVars['header_value'] || { mode: 'fixed', value: '', componentType: 'header', header_type: headerInfo.format.toLowerCase() };
                                        }
                                        const hasVars = varIndices.length > 0 || buttonVars.length > 0 || !!headerInfo?.hasVariable;
                                        setFormData({ ...formData, messagingWhatsappTemplate: value, messagingWhatsappVariables: hasVars ? JSON.stringify(newVars) : '' });
                                      }}
                                    >
                                      <SelectTrigger data-testid="select-whatsapp-template">
                                        <SelectValue placeholder={t('agents.systemTools.selectTemplatePlaceholder', 'Choose a template...')} />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {whatsappTemplates.map((template) => (
                                          <SelectItem key={template.name} value={template.name} data-testid={`select-whatsapp-template-${template.name}`}>
                                            {template.name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  {formData.messagingWhatsappTemplate && (() => {
                                    const varIndices = getWhatsAppTemplateVariables(formData.messagingWhatsappTemplate);
                                    const buttonVarDefs = getWhatsAppTemplateButtonVariables(formData.messagingWhatsappTemplate);
                                    const headerInfo = getWhatsAppTemplateHeaderInfo(formData.messagingWhatsappTemplate);
                                    if (varIndices.length === 0 && buttonVarDefs.length === 0 && !headerInfo?.hasVariable) return null;
                                    const currentVars = parseWhatsAppVariables(formData.messagingWhatsappVariables);
                                    const selectedTemplate = whatsappTemplates.find(t => t.name === formData.messagingWhatsappTemplate);
                                    const bodyComponent = selectedTemplate?.components?.find((c: any) => c.type === 'BODY');
                                    let sectionCount = 0;
                                    return (
                                      <div className="space-y-2 p-3 rounded-md border bg-muted/30">
                                        {headerInfo?.hasVariable && (() => {
                                          sectionCount++;
                                          const headerConfig = currentVars['header_value'] || currentVars['header'] || { mode: 'fixed' as const, value: '', componentType: 'header', header_type: headerInfo.format.toLowerCase() };
                                          const isMedia = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerInfo.format);
                                          return (
                                            <div>
                                              <Label className="text-xs font-medium block">Header Variable</Label>
                                              <p className="text-xs text-muted-foreground mb-2">
                                                {isMedia
                                                  ? `This template requires a ${headerInfo.format.toLowerCase()} URL for the header.`
                                                  : `Header text has a variable: ${headerInfo.text || ''}`}
                                              </p>
                                              <Input
                                                value={headerConfig.value}
                                                onChange={(e) => {
                                                  const updated = { ...currentVars, header_value: { mode: 'fixed' as const, value: e.target.value, componentType: 'header', header_type: headerInfo.format.toLowerCase() } };
                                                  setFormData({ ...formData, messagingWhatsappVariables: JSON.stringify(updated) });
                                                }}
                                                placeholder={isMedia ? `Enter ${headerInfo.format.toLowerCase()} URL` : 'Enter header text value'}
                                                className="text-sm"
                                                data-testid="input-whatsapp-header-var"
                                              />
                                            </div>
                                          );
                                        })()}
                                        {varIndices.length > 0 && (() => {
                                          const needsBorder = sectionCount > 0;
                                          sectionCount++;
                                          return (
                                            <div className={needsBorder ? "pt-2 mt-2 border-t" : ""}>
                                              <Label className="text-xs font-medium block">Template Variables</Label>
                                              {bodyComponent?.text && (
                                                <p className="text-xs text-muted-foreground italic break-words">{bodyComponent.text}</p>
                                              )}
                                              <p className="text-xs text-muted-foreground">For each variable, choose whether to use a fixed value or let the AI collect it from the caller.</p>
                                              {varIndices.map(idx => {
                                                const varConfig = currentVars[String(idx)] || { mode: 'collect' as const, value: '' };
                                                return (
                                                  <div key={idx} className="space-y-1.5">
                                                    <div className="flex items-center gap-2">
                                                      <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">{`{{${idx}}}`}</span>
                                                      <Select
                                                        value={varConfig.mode}
                                                        onValueChange={(mode) => {
                                                          const updated = { ...currentVars, [String(idx)]: { ...varConfig, mode: mode as 'fixed' | 'collect', value: '' } };
                                                          setFormData({ ...formData, messagingWhatsappVariables: JSON.stringify(updated) });
                                                        }}
                                                      >
                                                        <SelectTrigger className="w-[160px] text-xs" data-testid={`select-whatsapp-var-mode-${idx}`}>
                                                          <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                          <SelectItem value="fixed">Fixed value</SelectItem>
                                                          <SelectItem value="collect">Collect from caller</SelectItem>
                                                        </SelectContent>
                                                      </Select>
                                                      <Input
                                                        value={varConfig.value}
                                                        onChange={(e) => {
                                                          const updated = { ...currentVars, [String(idx)]: { ...varConfig, value: e.target.value } };
                                                          setFormData({ ...formData, messagingWhatsappVariables: JSON.stringify(updated) });
                                                        }}
                                                        placeholder={varConfig.mode === 'fixed' ? 'Enter exact value (e.g. SAVE20)' : 'Describe what to collect (e.g. Customer name)'}
                                                        className="text-sm flex-1"
                                                        data-testid={`input-whatsapp-var-${idx}`}
                                                      />
                                                    </div>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          );
                                        })()}
                                        {buttonVarDefs.length > 0 && (() => {
                                          const needsBorder = sectionCount > 0;
                                          return (
                                            <div className={needsBorder ? "pt-2 mt-2 border-t" : ""}>
                                              <Label className="text-xs font-medium block">Button Variables</Label>
                                              <p className="text-xs text-muted-foreground mb-2">URL buttons with dynamic parameters require a value for the variable portion of the URL.</p>
                                              {buttonVarDefs.map(btn => {
                                                const key = `btn_${btn.index}`;
                                                const btnConfig = currentVars[key] || { mode: 'fixed' as const, value: '', componentType: 'button' };
                                                return (
                                                  <div key={key} className="space-y-1.5">
                                                    <div className="flex items-center gap-2">
                                                      <span className="text-xs font-mono text-muted-foreground whitespace-nowrap truncate max-w-[140px]" title={btn.url}>{btn.label}</span>
                                                      <Input
                                                        value={btnConfig.value}
                                                        onChange={(e) => {
                                                          const updated = { ...currentVars, [key]: { mode: 'fixed' as const, value: e.target.value, componentType: 'button' } };
                                                          setFormData({ ...formData, messagingWhatsappVariables: JSON.stringify(updated) });
                                                        }}
                                                        placeholder={`Dynamic URL value (e.g. order-123)`}
                                                        className="text-sm flex-1"
                                                        data-testid={`input-whatsapp-btn-var-${btn.index}`}
                                                      />
                                                    </div>
                                                    <p className="text-xs text-muted-foreground ml-1 break-all">{btn.url}</p>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          );
                                        })()}
                                      </div>
                                    );
                                  })()}
                                </div>
                              ) : (
                                formData.messagingWhatsappEnabled && (
                                  <div className="ml-8 text-xs text-amber-600 dark:text-amber-400 font-medium bg-amber-50 dark:bg-amber-950/20 p-2.5 rounded border border-amber-200 dark:border-amber-900/50">
                                    {t('agents.systemTools.noWhatsappTemplates', 'No WhatsApp templates found. Please check your WhatsWay or Meta WhatsApp integration and ensure you have approved templates.')}
                                  </div>
                                )
                              )}
                            </div>
                          )}
                        </div>
  );
}
