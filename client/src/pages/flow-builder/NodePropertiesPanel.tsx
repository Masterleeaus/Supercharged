/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
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

import { useTranslation } from "react-i18next";
import { type Node, Panel } from "@xyflow/react";
import { Button } from "@/components/ui/button";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Play, MessageSquare, Webhook, Phone, X, Trash2, Info, Volume2, Upload, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

import { GoogleSheetsPicker } from "@/components/GoogleSheetsPicker";

import { FlowNode, FlowFormSummary, nodeTypeIcons } from "./types";
import type { Dispatch, SetStateAction } from "react";

export interface NodePropertiesPanelProps {
  agentId: string;
  selectedNode: FlowNode | null;
  setSelectedNode: Dispatch<SetStateAction<FlowNode | null>>;
  sheetsExpandedAppointment: boolean;
  setSheetsExpandedAppointment: Dispatch<SetStateAction<boolean>>;
  sheetsExpandedForm: boolean;
  setSheetsExpandedForm: Dispatch<SetStateAction<boolean>>;
  availableForms: FlowFormSummary[] | undefined;
  isLoadingForms: boolean;
  emailTemplatesForFlow: any[] | undefined;
  waTemplatesForFlow: any[] | undefined;
  isElevenLabsEngine: boolean;
  updateNodeConfig: (config: any) => void;
  deleteNode: () => void;
  getAvailableNodes: () => Array<{ id: string; label: string }>;
}

export function NodePropertiesPanel(props: NodePropertiesPanelProps) {
  const { agentId, selectedNode, setSelectedNode, sheetsExpandedAppointment, setSheetsExpandedAppointment, sheetsExpandedForm, setSheetsExpandedForm, availableForms, isLoadingForms, emailTemplatesForFlow, waTemplatesForFlow, isElevenLabsEngine, updateNodeConfig, deleteNode, getAvailableNodes } = props;
  const { t } = useTranslation();
  const { toast } = useToast();
  return (
    <>
          {/* Properties Panel (Right Sidebar) with Teal Theme */}
          {selectedNode && (
            <div className="absolute right-0 top-0 bottom-0 w-72 bg-gradient-to-b from-brand/5 via-background to-background dark:from-brand/10 dark:via-background border-l shadow-lg overflow-y-auto z-10">
              <div className="p-4 border-b border-brand/20 dark:border-brand/20 flex items-center justify-between sticky top-0 bg-gradient-to-r from-brand/5 to-brand/3 dark:from-brand/10 dark:to-brand/5 backdrop-blur z-10">
                <div className="flex items-center gap-2">
                  {(() => {
                    const Icon = nodeTypeIcons[selectedNode.data.type as keyof typeof nodeTypeIcons] || MessageSquare;
                    return <Icon className="w-4 h-4 text-brand" />;
                  })()}
                  <h3 className="font-semibold text-sm text-foreground">{t("flows.nodeProperties")}</h3>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={deleteNode}
                    data-testid="button-delete-node"
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setSelectedNode(null)}
                    data-testid="button-close-properties"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div className="p-4 space-y-4">
                {/* Node ID (read-only reference) */}
                <div>
                  <Label className="text-xs text-muted-foreground">{t("flows.nodeId")}</Label>
                  <div className="text-sm font-mono bg-muted/50 px-2 py-1.5 rounded mt-1 break-all">
                    {selectedNode.id}
                  </div>
                </div>

                {/* Message Node */}
                {selectedNode.data.type === "message" && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="message">{t("flows.nodeConfig.message")}</Label>
                      <Textarea
                        id="message"
                        value={selectedNode.data.config?.message || ""}
                        onChange={(e) => updateNodeConfig({ message: e.target.value })}
                        placeholder={t("flows.nodeConfig.messagePlaceholder")}
                        className="mt-1"
                        data-testid="input-message"
                      />
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponse"
                        checked={selectedNode.data.config?.waitForResponse ?? false}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponse" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                  </div>
                )}

                {/* Question Node */}
                {selectedNode.data.type === "question" && (
                  <>
                    <div>
                      <Label htmlFor="question">{t("flows.nodeConfig.question")}</Label>
                      <Textarea
                        id="question"
                        value={selectedNode.data.config?.question || ""}
                        onChange={(e) => updateNodeConfig({ question: e.target.value })}
                        placeholder={t("flows.nodeConfig.questionPlaceholder")}
                        className="mt-1"
                        data-testid="input-question"
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Label htmlFor="variableName">{t("flows.nodeConfig.variableName")}</Label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="text-xs">
                                {t("flows.nodeConfig.variableTooltip")}
                              </p>
                              <div className="mt-2 p-2 bg-muted rounded text-xs font-mono">
                                {t("flows.nodeConfig.variableExample")}<br />
                                Variable: transfer_consent<br />
                                Use in condition: transfer_consent == "yes"
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Input
                        id="variableName"
                        value={selectedNode.data.config?.variableName || ""}
                        onChange={(e) => updateNodeConfig({ variableName: e.target.value })}
                        placeholder={t("flows.nodeConfig.variableNamePlaceholder")}
                        className="mt-1"
                        data-testid="input-variable-name"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.variableNameHint")}
                      </p>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponseQuestion"
                        checked={selectedNode.data.config?.waitForResponse ?? true}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponseQuestion" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                  </>
                )}

                {/* Condition Node with Smart Node Selector */}
                {selectedNode.data.type === "condition" && (
                  <>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Label htmlFor="condition">{t("flows.nodeConfig.condition")}</Label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="text-xs mb-2">
                                {t("flows.nodeConfig.conditionTooltip")}
                              </p>
                              <div className="space-y-1 text-xs font-mono bg-muted p-2 rounded">
                                <div>transfer_consent == "yes"</div>
                                <div>age &gt; 18</div>
                                <div>response contains "help"</div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Textarea
                        id="condition"
                        value={selectedNode.data.config?.condition || ""}
                        onChange={(e) => updateNodeConfig({ condition: e.target.value })}
                        placeholder={t("flows.nodeConfig.conditionPlaceholder")}
                        className="mt-1"
                        data-testid="input-condition"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.conditionHint")}
                      </p>
                    </div>

                    {/* True Branch - Node Selector */}
                    <div>
                      <Label htmlFor="trueBranch">{t("flows.nodeConfig.trueBranch")}</Label>
                      <Select
                        value={selectedNode.data.config?.trueBranch || ""}
                        onValueChange={(value) => updateNodeConfig({ trueBranch: value })}
                      >
                        <SelectTrigger className="mt-1" data-testid="select-true-branch">
                          <SelectValue placeholder={t("flows.nodeConfig.selectNextNode")} />
                        </SelectTrigger>
                        <SelectContent>
                          {getAvailableNodes()
                            .filter((n) => n.id !== selectedNode.id)
                            .map((node) => (
                              <SelectItem key={node.id} value={node.id}>
                                {node.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* False Branch - Node Selector */}
                    <div>
                      <Label htmlFor="falseBranch">{t("flows.nodeConfig.falseBranch")}</Label>
                      <Select
                        value={selectedNode.data.config?.falseBranch || ""}
                        onValueChange={(value) => updateNodeConfig({ falseBranch: value })}
                      >
                        <SelectTrigger className="mt-1" data-testid="select-false-branch">
                          <SelectValue placeholder={t("flows.nodeConfig.selectNextNode")} />
                        </SelectTrigger>
                        <SelectContent>
                          {getAvailableNodes()
                            .filter((n) => n.id !== selectedNode.id)
                            .map((node) => (
                              <SelectItem key={node.id} value={node.id}>
                                {node.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                {/* Transfer Node */}
                {selectedNode.data.type === "transfer" && (
                  <div>
                    <Label htmlFor="phoneNumber">{t("flows.nodeConfig.phoneNumber")}</Label>
                    <Input
                      id="phoneNumber"
                      value={selectedNode.data.config?.phoneNumber || ""}
                      onChange={(e) => updateNodeConfig({ phoneNumber: e.target.value })}
                      placeholder={t("flows.nodeConfig.phoneNumberPlaceholder")}
                      className="mt-1"
                      data-testid="input-phone-number"
                    />
                  </div>
                )}

                {/* Delay Node */}
                {selectedNode.data.type === "delay" && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="duration">{t("flows.nodeConfig.duration")}</Label>
                      <Input
                        id="duration"
                        type="number"
                        value={selectedNode.data.config?.duration || 1}
                        onChange={(e) => updateNodeConfig({ duration: parseInt(e.target.value) })}
                        placeholder={t("flows.nodeConfig.durationPlaceholder")}
                        min="1"
                        className="mt-1"
                        data-testid="input-duration"
                      />
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponseDelay"
                        checked={selectedNode.data.config?.waitForResponse ?? false}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponseDelay" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                  </div>
                )}

                {/* Play Audio Node */}
                {selectedNode.data.type === "play_audio" && (
                  <div className="space-y-4">
                    {/* Warning for ElevenLabs engines that don't support audio playback */}
                    {(!agentId || isElevenLabsEngine) && (
                      <Alert variant="destructive" className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800">
                        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        <AlertTitle className="text-amber-800 dark:text-amber-200">{t("flows.nodeConfig.playAudioWarningTitle")}</AlertTitle>
                        <AlertDescription className="text-amber-700 dark:text-amber-300 text-xs">
                          {t("flows.nodeConfig.playAudioWarningElevenLabs")}
                        </AlertDescription>
                      </Alert>
                    )}
                    <div>
                      <Label>{t("flows.nodeConfig.audioFile")}</Label>
                      {selectedNode.data.config?.audioUrl ? (
                        <div className="mt-2 p-3 bg-muted/50 rounded-lg border">
                          <div className="flex items-center gap-2">
                            <Volume2 className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm font-medium truncate flex-1">
                              {selectedNode.data.config?.audioFileName || "Audio file"}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 flex-shrink-0"
                              onClick={() => updateNodeConfig({ audioUrl: "", audioFileName: "" })}
                              data-testid="button-remove-audio"
                            >
                              <X className="w-4 h-4 text-destructive" />
                            </Button>
                          </div>
                          <audio
                            controls
                            src={selectedNode.data.config?.audioUrl}
                            className="w-full mt-2 h-8"
                            data-testid="audio-preview"
                          />
                        </div>
                      ) : (
                        <div className="mt-2">
                          <label className="flex flex-col items-center justify-center w-full h-24 border-2 border-dashed rounded-lg cursor-pointer bg-muted/30 hover:bg-muted/50 border-cyan-300 dark:border-cyan-700">
                            <div className="flex flex-col items-center justify-center pt-2 pb-2">
                              <Upload className="w-6 h-6 mb-1 text-cyan-600" />
                              <p className="text-xs text-muted-foreground">{t("flows.nodeConfig.uploadAudio")}</p>
                              <p className="text-xs text-muted-foreground/70">MP3, WAV (max 5MB)</p>
                            </div>
                            <input
                              type="file"
                              className="hidden"
                              accept=".mp3,.wav,audio/mpeg,audio/wav"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                if (file.size > 5 * 1024 * 1024) {
                                  toast({ title: t("flows.nodeConfig.fileTooLarge"), variant: "destructive" });
                                  return;
                                }
                                const formData = new FormData();
                                formData.append("audio", file);
                                try {
                                  const token = localStorage.getItem("auth_token");
                                  const res = await fetch("/api/audio/upload", {
                                    method: "POST",
                                    body: formData,
                                    headers: token ? { Authorization: `Bearer ${token}` } : {}
                                  });
                                  if (!res.ok) throw new Error("Upload failed");
                                  const data = await res.json();
                                  updateNodeConfig({ audioUrl: data.url, audioFileName: file.name });
                                  toast({ title: t("flows.nodeConfig.audioUploaded") });
                                } catch (err) {
                                  toast({ title: t("flows.nodeConfig.uploadFailed"), variant: "destructive" });
                                }
                              }}
                              data-testid="input-audio-upload"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="interruptible"
                        checked={selectedNode.data.config?.interruptible ?? false}
                        onCheckedChange={(checked) => updateNodeConfig({ interruptible: !!checked })}
                        data-testid="checkbox-interruptible"
                      />
                      <Label htmlFor="interruptible" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.interruptible")}
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForComplete"
                        checked={selectedNode.data.config?.waitForComplete ?? true}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForComplete: !!checked })}
                        data-testid="checkbox-wait-for-complete"
                      />
                      <Label htmlFor="waitForComplete" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForComplete")}
                      </Label>
                    </div>
                  </div>
                )}

                {/* Webhook Node */}
                {selectedNode.data.type === "webhook" && (
                  <div>
                    <Label htmlFor="webhookUrl">{t("flows.nodeConfig.webhookUrl")}</Label>
                    <Input
                      id="webhookUrl"
                      value={selectedNode.data.config?.webhookUrl || ""}
                      onChange={(e) => updateNodeConfig({ webhookUrl: e.target.value })}
                      placeholder={t("flows.nodeConfig.webhookUrlPlaceholder")}
                      className="mt-1"
                      data-testid="input-webhook-url"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("flows.nodeConfig.webhookHint")}
                    </p>
                  </div>
                )}

                {/* Form Node */}
                {selectedNode.data.type === "form" && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="formId">{t("flows.nodeConfig.selectForm")}</Label>
                      <Select
                        value={selectedNode.data.config?.formId || ""}
                        onValueChange={(value) => {
                          const selectedForm = availableForms?.find(f => f.id === value);
                          updateNodeConfig({
                            formId: value,
                            formName: selectedForm?.name || ""
                          });
                        }}
                      >
                        <SelectTrigger className="mt-1" data-testid="select-form">
                          <SelectValue placeholder={t("flows.nodeConfig.selectFormPlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          {availableForms?.map((form) => (
                            <SelectItem key={form.id} value={form.id}>
                              {form.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {(!availableForms || availableForms.length === 0) && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                          {t("flows.nodeConfig.noFormsAvailable")}
                        </p>
                      )}
                    </div>

                    <div>
                      <Label htmlFor="formIntroMessage">{t("flows.nodeConfig.introMessage")}</Label>
                      <Textarea
                        id="formIntroMessage"
                        value={selectedNode.data.config?.message || ""}
                        onChange={(e) => updateNodeConfig({ message: e.target.value })}
                        placeholder={t("flows.nodeConfig.formIntroPlaceholder")}
                        className="mt-1"
                        rows={2}
                        data-testid="input-form-intro"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.formIntroHint")}
                      </p>
                    </div>

                    {selectedNode.data.config?.formId && (() => {
                      const selectedForm = availableForms?.find(f => f.id === selectedNode.data.config?.formId);
                      const formFields = selectedForm?.fields;

                      return (
                        <div className="p-3 bg-muted/50 rounded-md">
                          <p className="text-xs font-medium text-muted-foreground mb-2">
                            {t("flows.nodeConfig.formFieldsPreview")}
                          </p>
                          {isLoadingForms || !availableForms ? (
                            <p className="text-xs text-muted-foreground italic">
                              {t("flows.nodeConfig.loadingFields")}
                            </p>
                          ) : !selectedForm ? (
                            <p className="text-xs text-amber-600 dark:text-amber-400">
                              {t("flows.nodeConfig.formNotFound")}
                            </p>
                          ) : formFields && formFields.length > 0 ? (
                            <ul className="text-xs space-y-1">
                              {formFields
                                .sort((a, b) => a.order - b.order)
                                .map((field, idx) => (
                                  <li key={field.id} className="flex items-center gap-2">
                                    <span className="text-muted-foreground">{idx + 1}.</span>
                                    <span>{field.question}</span>
                                    {field.isRequired && (
                                      <span className="text-amber-600 dark:text-amber-400">*</span>
                                    )}
                                  </li>
                                ))}
                            </ul>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">
                              {t("flows.nodeConfig.noFieldsDefined")}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponseForm"
                        checked={selectedNode.data.config?.waitForResponse ?? true}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponseForm" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                    <GoogleSheetsPicker
                      sheetId={selectedNode.data.config?.googleSheetId || ""}
                      sheetName={selectedNode.data.config?.googleSheetName || ""}
                      sheetTitle={selectedNode.data.config?.googleSheetTitle || ""}
                      expanded={sheetsExpandedForm}
                      onToggleExpanded={() => setSheetsExpandedForm((v) => !v)}
                      onSheetChange={(id, title) => updateNodeConfig({ googleSheetId: id, googleSheetTitle: title })}
                      onTabChange={(name) => updateNodeConfig({ googleSheetName: name })}
                    />
                  </div>
                )}

                {/* Appointment Node */}
                {selectedNode.data.type === "appointment" && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="appointmentType">{t("flows.nodeConfig.appointmentType")}</Label>
                      <Input
                        id="appointmentType"
                        value={selectedNode.data.config?.appointmentType || ""}
                        onChange={(e) => updateNodeConfig({ appointmentType: e.target.value })}
                        placeholder={t("flows.nodeConfig.appointmentTypePlaceholder")}
                        className="mt-1"
                        data-testid="input-appointment-type"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.appointmentHint")}
                      </p>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponseAppointment"
                        checked={selectedNode.data.config?.waitForResponse ?? true}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponseAppointment" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                    <GoogleSheetsPicker
                      sheetId={selectedNode.data.config?.googleSheetId || ""}
                      sheetName={selectedNode.data.config?.googleSheetName || ""}
                      sheetTitle={selectedNode.data.config?.googleSheetTitle || ""}
                      expanded={sheetsExpandedAppointment}
                      onToggleExpanded={() => setSheetsExpandedAppointment((v) => !v)}
                      onSheetChange={(id, title) => updateNodeConfig({ googleSheetId: id, googleSheetTitle: title })}
                      onTabChange={(name) => updateNodeConfig({ googleSheetName: name })}
                    />
                  </div>
                )}

                {/* Send Email Node */}
                {selectedNode.data.type === "send_email" && (() => {
                  const emailList = emailTemplatesForFlow || [];
                  if (emailList.length === 1 && !selectedNode.data.config?.templateName) {
                    setTimeout(() => updateNodeConfig({ templateName: emailList[0].name }), 0);
                  }
                  return true;
                })() && (
                    <div className="space-y-4">
                      <div>
                        <Label>{t("flows.nodeConfig.emailTemplate", "Email Template")}</Label>
                        {(emailTemplatesForFlow || []).length === 0 ? (
                          <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 mt-1" data-testid="warning-no-email-templates">
                            <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
                            <p className="text-xs text-yellow-700 dark:text-yellow-300">
                              No email templates found. Go to Messaging settings to create email templates before using this node.
                            </p>
                          </div>
                        ) : (
                          <Select
                            value={selectedNode.data.config?.templateName || ""}
                            onValueChange={(val) => updateNodeConfig({ templateName: val })}
                          >
                            <SelectTrigger className="mt-1" data-testid="select-email-template-name">
                              <SelectValue placeholder={t("flows.nodeConfig.emailTemplatePlaceholder", "Select an email template")} />
                            </SelectTrigger>
                            <SelectContent>
                              {(emailTemplatesForFlow || []).map((tmpl: any) => (
                                <SelectItem key={tmpl.id || tmpl.name} value={tmpl.name}>
                                  {tmpl.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("flows.nodeConfig.emailTemplateHint", "Select an email template from your Messaging settings.")}
                        </p>
                      </div>
                      <div>
                        <Label htmlFor="recipientEmail">{t("flows.nodeConfig.recipientEmail", "Recipient Email")}</Label>
                        <Input
                          id="recipientEmail"
                          value={selectedNode.data.config?.recipientEmail || ""}
                          onChange={(e) => updateNodeConfig({ recipientEmail: e.target.value })}
                          placeholder={t("flows.nodeConfig.recipientEmailPlaceholder", "Leave empty to collect during call")}
                          className="mt-1"
                          data-testid="input-recipient-email"
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("flows.nodeConfig.recipientEmailHint", "Leave empty to ask the caller for their email. The agent will collect it before sending.")}
                        </p>
                      </div>
                    </div>
                  )}

                {/* Send WhatsApp Node */}
                {selectedNode.data.type === "send_whatsapp" && (
                  <div className="space-y-4">
                    <div>
                      <Label>{t("flows.nodeConfig.whatsappTemplate", "WhatsApp Template")}</Label>
                      {(waTemplatesForFlow || []).length === 0 ? (
                        <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 mt-1" data-testid="warning-no-whatsapp-templates">
                          <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
                          <p className="text-xs text-yellow-700 dark:text-yellow-300">
                            No WhatsApp templates found. Configure a WhatsApp provider (Meta or Whatsway) in Messaging settings and ensure you have approved templates.
                          </p>
                        </div>
                      ) : (
                        <Select
                          value={selectedNode.data.config?.templateName || ""}
                          onValueChange={(val) => {
                            const tmpl = (waTemplatesForFlow || []).find((t: any) => t.name === val);
                            const body = tmpl?.body || "";
                            const varMatches = body.match(/\{\{(\d+)\}\}/g) || [];
                            const positions = Array.from(new Set<number>(varMatches.map((m: string) => parseInt(m.replace(/[{}]/g, ""), 10)))).sort((a: number, b: number) => a - b);
                            const existingVars = selectedNode.data.config?.templateVariables || [];
                            const templateVariables = positions.map((pos: number) => {
                              const existing = existingVars.find((v: any) => v.position === pos);
                              return existing || { position: pos, source: "custom", value: "" };
                            });
                            const header = tmpl?.header || null;
                            const headerFormat = header?.format?.toUpperCase() || "";
                            const prevHeaderType = selectedNode.data.config?.headerVariable?.type || null;
                            let headerConfig: any = null;
                            if (header && ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat)) {
                              const newType = headerFormat.toLowerCase();
                              if (prevHeaderType === newType && selectedNode.data.config?.headerVariable) {
                                headerConfig = selectedNode.data.config.headerVariable;
                              } else {
                                headerConfig = { type: newType, url: "" };
                              }
                            } else if (header && headerFormat === "TEXT" && header.text?.match(/\{\{\d+\}\}/)) {
                              if (prevHeaderType === "text" && selectedNode.data.config?.headerVariable) {
                                headerConfig = selectedNode.data.config.headerVariable;
                              } else {
                                headerConfig = { type: "text", value: "", source: "custom" };
                              }
                            }
                            const buttons = tmpl?.buttons || [];
                            const existingBtnVars = selectedNode.data.config?.buttonVariables || [];
                            const buttonVariables = buttons
                              .map((btn: any, idx: number) => {
                                if (btn.type === "URL" && btn.url?.includes("{{")) {
                                  const existing = existingBtnVars.find((bv: any) => bv.index === idx);
                                  return existing || { index: idx, label: btn.text || `Button ${idx + 1}`, url: btn.url, value: "" };
                                }
                                return null;
                              })
                              .filter(Boolean);
                            updateNodeConfig({ templateName: val, language: tmpl?.language || "en_US", templateBody: body, templateVariables, headerVariable: headerConfig, buttonVariables, templateComponents: tmpl?.components || [] });
                          }}
                        >
                          <SelectTrigger className="mt-1" data-testid="select-whatsapp-template-name">
                            <SelectValue placeholder={t("flows.nodeConfig.whatsappTemplatePlaceholder", "Select a WhatsApp template")} />
                          </SelectTrigger>
                          <SelectContent>
                            {(waTemplatesForFlow || []).map((tmpl: any, idx: number) => (
                              <SelectItem key={`${tmpl.name}-${idx}`} value={tmpl.name}>
                                {tmpl.name} ({tmpl.language})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.whatsappTemplateHint", "Select an approved WhatsApp template from your connected account.")}
                      </p>
                    </div>

                    {selectedNode.data.config?.templateBody && (
                      <div className="bg-muted/50 rounded p-3 text-xs text-muted-foreground border">
                        <p className="font-medium text-foreground mb-1">Template Preview</p>
                        {selectedNode.data.config.templateBody}
                      </div>
                    )}

                    {selectedNode.data.config?.headerVariable && (
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">
                          Header {selectedNode.data.config.headerVariable.type === "text" ? "Text Variable" : `${(selectedNode.data.config.headerVariable.type || "image").charAt(0).toUpperCase() + (selectedNode.data.config.headerVariable.type || "image").slice(1)} URL`}
                        </Label>
                        {selectedNode.data.config.headerVariable.type === "text" ? (
                          <div className="space-y-1.5">
                            <Select
                              value={selectedNode.data.config.headerVariable.source || "custom"}
                              onValueChange={(src) => {
                                const hv = selectedNode.data.config?.headerVariable;
                                updateNodeConfig({
                                  headerVariable: {
                                    ...hv,
                                    source: src,
                                    value: src === "custom" ? hv?.value : `{{${src}}}`,
                                  },
                                });
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs" data-testid="select-wa-header-source">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="custom">Custom text</SelectItem>
                                <SelectItem value="contact_name">Contact Name</SelectItem>
                                <SelectItem value="contact_phone">Phone Number</SelectItem>
                                <SelectItem value="contact_email">Email</SelectItem>
                                <SelectItem value="agent_name">Agent Name</SelectItem>
                                <SelectItem value="system__caller_id">Caller ID</SelectItem>
                              </SelectContent>
                            </Select>
                            {(selectedNode.data.config.headerVariable.source === "custom" || !selectedNode.data.config.headerVariable.source) && (
                              <Input
                                value={selectedNode.data.config.headerVariable.value || ""}
                                onChange={(e) => updateNodeConfig({ headerVariable: { ...selectedNode.data.config?.headerVariable, value: e.target.value } })}
                                placeholder="Header text value"
                                className="h-8 text-xs"
                                data-testid="input-wa-header-value"
                              />
                            )}
                          </div>
                        ) : (
                          <Input
                            value={selectedNode.data.config.headerVariable.url || ""}
                            onChange={(e) => updateNodeConfig({ headerVariable: { ...selectedNode.data.config?.headerVariable, url: e.target.value } })}
                            placeholder={`https://example.com/${selectedNode.data.config.headerVariable.type || "image"}.${selectedNode.data.config.headerVariable.type === "video" ? "mp4" : selectedNode.data.config.headerVariable.type === "document" ? "pdf" : "jpg"}`}
                            className="h-8 text-xs"
                            data-testid="input-wa-header-url"
                          />
                        )}
                        <p className="text-xs text-muted-foreground">
                          {selectedNode.data.config.headerVariable.type === "text"
                            ? "Set the text variable for the template header."
                            : `Provide the public URL for the ${selectedNode.data.config.headerVariable.type || "media"} file.`}
                        </p>
                      </div>
                    )}

                    {(selectedNode.data.config?.templateVariables || []).length > 0 && (
                      <div className="space-y-3">
                        <Label className="text-sm font-medium">Body Variable Mapping</Label>
                        {(selectedNode.data.config?.templateVariables as any[] || []).map((tv: any) => (
                          <div key={tv.position} className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{`Variable {{${tv.position}}}`}</Label>
                            <Select
                              value={tv.source || "custom"}
                              onValueChange={(src) => {
                                const updated = (selectedNode.data.config?.templateVariables as any[] || []).map((v: any) =>
                                  v.position === tv.position
                                    ? { ...v, source: src, value: src === "custom" ? v.value : `{{${src}}}` }
                                    : v
                                );
                                updateNodeConfig({ templateVariables: updated });
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs" data-testid={`select-wa-var-source-${tv.position}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="custom">Custom text</SelectItem>
                                <SelectItem value="contact_name">Contact Name</SelectItem>
                                <SelectItem value="contact_phone">Phone Number</SelectItem>
                                <SelectItem value="contact_email">Email</SelectItem>
                                <SelectItem value="agent_name">Agent Name</SelectItem>
                                <SelectItem value="system__caller_id">Caller ID</SelectItem>
                              </SelectContent>
                            </Select>
                            {(tv.source === "custom" || !tv.source) && (
                              <Input
                                value={tv.value || ""}
                                onChange={(e) => {
                                  const updated = (selectedNode.data.config?.templateVariables as any[] || []).map((v: any) =>
                                    v.position === tv.position ? { ...v, value: e.target.value } : v
                                  );
                                  updateNodeConfig({ templateVariables: updated });
                                }}
                                placeholder={`Value for {{${tv.position}}}`}
                                className="h-8 text-xs"
                                data-testid={`input-wa-var-value-${tv.position}`}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {(selectedNode.data.config?.buttonVariables || []).length > 0 && (
                      <div className="space-y-3">
                        <Label className="text-sm font-medium">Button URL Variables</Label>
                        {(selectedNode.data.config?.buttonVariables as any[] || []).map((bv: any) => (
                          <div key={bv.index} className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">
                              {bv.label || `Button ${bv.index + 1}`}
                              {bv.url ? <span className="ml-1 opacity-60">({bv.url})</span> : null}
                            </Label>
                            <Input
                              value={bv.value || ""}
                              onChange={(e) => {
                                const updated = (selectedNode.data.config?.buttonVariables as any[] || []).map((v: any) =>
                                  v.index === bv.index ? { ...v, value: e.target.value } : v
                                );
                                updateNodeConfig({ buttonVariables: updated });
                              }}
                              placeholder="Dynamic URL suffix value"
                              className="h-8 text-xs"
                              data-testid={`input-wa-btn-value-${bv.index}`}
                            />
                          </div>
                        ))}
                        <p className="text-xs text-muted-foreground">
                          Set the dynamic portion of URL button links.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* End Node */}
                {selectedNode.data.type === "end" && (
                  <div>
                    <Label htmlFor="endMessage">{t("flows.nodeConfig.endMessage")}</Label>
                    <Textarea
                      id="endMessage"
                      value={selectedNode.data.config?.endMessage || ""}
                      onChange={(e) => updateNodeConfig({ endMessage: e.target.value })}
                      placeholder={t("flows.nodeConfig.endMessagePlaceholder")}
                      className="mt-1"
                      data-testid="input-end-message"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
    </>
  );
}
