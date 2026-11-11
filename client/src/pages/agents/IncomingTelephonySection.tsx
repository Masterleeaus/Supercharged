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
import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";
import { Label } from "@/components/ui/label";
import type { Dispatch, SetStateAction } from "react";
import { AgentFormData } from "@/pages/agents/shared";

export interface IncomingTelephonySectionProps {
  formData: AgentFormData;
  setFormData: Dispatch<SetStateAction<AgentFormData>>;
  availableLLMModels: { id: string; modelId: string; name: string; provider: string; tier: "free" | "pro"; isActive: boolean; }[];
  isTwilioOpenaiEnabled: boolean;
  isPlivoEnabled: boolean;
  isOpenAISipAllowed: boolean;
  isCustomVoiceEngineEnabled: boolean;
}

export function IncomingTelephonySection({ formData, setFormData, availableLLMModels, isTwilioOpenaiEnabled, isPlivoEnabled, isOpenAISipAllowed, isCustomVoiceEngineEnabled }: IncomingTelephonySectionProps) {
  return (
    <div className="space-y-2">
                      <Label>Telephony Provider</Label>
                      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                        {/* ElevenLabs + Twilio - Purple theme */}
                        <div
                          className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${formData.telephonyProvider === "twilio"
                            ? "border-violet-500 bg-violet-500/10 dark:bg-violet-500/20"
                            : "border-border hover:border-violet-400/50 hover:bg-violet-500/5"
                            }`}
                          onClick={() => setFormData({
                            ...formData,
                            telephonyProvider: "twilio",
                            type: formData.type === "custom_engine" ? "incoming" : formData.type,
                            llmModel: availableLLMModels.length > 0 ? availableLLMModels[0].modelId : "gpt-4o-mini"
                          })}
                          data-testid="provider-twilio"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium text-violet-700 dark:text-violet-300">ElevenLabs + Twilio</span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                Premium voice quality, 30+ languages
                              </p>
                            </div>
                            {formData.telephonyProvider === "twilio" && (
                              <Check className="h-4 w-4 text-violet-600" />
                            )}
                          </div>
                        </div>
                        {/* OpenAI + Twilio - Teal theme */}
                        {(isTwilioOpenaiEnabled || formData.telephonyProvider === "twilio_openai") && (
                          <div
                            className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${formData.telephonyProvider === "twilio_openai"
                              ? "border-brand bg-brand/10 dark:bg-brand/20"
                              : "border-border hover:border-brand/50 hover:bg-brand/5"
                              }`}
                            onClick={() => setFormData({
                              ...formData,
                              telephonyProvider: "twilio_openai",
                              type: formData.type === "custom_engine" ? "incoming" : formData.type,
                              llmModel: "gpt-realtime-1.5"
                            })}
                            data-testid="provider-twilio-openai"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium text-brand">OpenAI + Twilio</span>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  Real-time AI, international
                                </p>
                              </div>
                              {formData.telephonyProvider === "twilio_openai" && (
                                <Check className="h-4 w-4 text-brand" />
                              )}
                            </div>
                          </div>
                        )}
                        {/* OpenAI + Plivo - Green theme */}
                        {(isPlivoEnabled || formData.telephonyProvider === "plivo") && (
                          <div
                            className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${formData.telephonyProvider === "plivo"
                              ? "border-emerald-500 bg-emerald-500/10 dark:bg-emerald-500/20"
                              : "border-border hover:border-emerald-400/50 hover:bg-emerald-500/5"
                              }`}
                            onClick={() => setFormData({
                              ...formData,
                              telephonyProvider: "plivo",
                              type: formData.type === "custom_engine" ? "incoming" : formData.type,
                              llmModel: "gpt-realtime-1.5"
                            })}
                            data-testid="provider-plivo"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium text-emerald-700 dark:text-emerald-300">OpenAI + Plivo</span>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  Real-time AI, India numbers
                                </p>
                              </div>
                              {formData.telephonyProvider === "plivo" && (
                                <Check className="h-4 w-4 text-emerald-600" />
                              )}
                            </div>
                          </div>
                        )}
                        {/* ElevenLabs SIP - Orange theme */}
                        {/* {(isElevenLabsSipAllowed || formData.telephonyProvider === "elevenlabs-sip") && (
                          <div
                            className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${formData.telephonyProvider === "elevenlabs-sip"
                              ? "border-orange-500 bg-orange-500/10 dark:bg-orange-500/20"
                              : "border-border hover:border-orange-400/50 hover:bg-orange-500/5"
                              }`}
                            onClick={() => setFormData({
                              ...formData,
                              telephonyProvider: "elevenlabs-sip",
                              type: formData.type === "custom_engine" ? "incoming" : formData.type,
                              llmModel: availableLLMModels.length > 0 ? availableLLMModels[0].modelId : "gpt-4o-mini"
                            })}
                            data-testid="provider-elevenlabs-sip"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium text-orange-700 dark:text-orange-300">ElevenLabs SIP</span>
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-orange-300 text-orange-600 dark:border-orange-600 dark:text-orange-400">Plugin</Badge>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  Your own SIP trunk
                                </p>
                              </div>
                              {formData.telephonyProvider === "elevenlabs-sip" && (
                                <Check className="h-4 w-4 text-orange-600" />
                              )}
                            </div>
                          </div>
                        )} */}
                        {/* OpenAI SIP - Pink theme */}
                        {(isOpenAISipAllowed || formData.telephonyProvider === "openai-sip") && (
                          <div
                            className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${formData.telephonyProvider === "openai-sip"
                              ? "border-pink-500 bg-pink-500/10 dark:bg-pink-500/20"
                              : "border-border hover:border-pink-400/50 hover:bg-pink-500/5"
                              }`}
                            onClick={() => setFormData({
                              ...formData,
                              telephonyProvider: "openai-sip",
                              type: formData.type === "custom_engine" ? "incoming" : formData.type,
                              llmModel: "gpt-realtime-1.5"
                            })}
                            data-testid="provider-openai-sip"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium text-pink-700 dark:text-pink-300">OpenAI SIP</span>
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-pink-300 text-pink-600 dark:border-pink-600 dark:text-pink-400">Plugin</Badge>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  Your own SIP trunk
                                </p>
                              </div>
                              {formData.telephonyProvider === "openai-sip" && (
                                <Check className="h-4 w-4 text-pink-600" />
                              )}
                            </div>
                          </div>
                        )}
                        {/* Custom Voice Engine - Indigo/Indigo theme */}
                        {isCustomVoiceEngineEnabled && (
                          <div
                            className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${formData.telephonyProvider === "custom-voice-engine"
                              ? "border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/20"
                              : "border-border hover:border-indigo-400/50 hover:bg-indigo-500/5"
                              }`}
                            onClick={() => setFormData({
                              ...formData,
                              telephonyProvider: "custom-voice-engine",
                              type: "custom_engine",
                              llmModel: "openai/gpt-4o-mini"
                            })}
                            data-testid="provider-custom-voice-engine"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium text-indigo-700 dark:text-indigo-300">Custom Voice Engine</span>
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-indigo-300 text-indigo-600 dark:border-indigo-600 dark:text-indigo-400">Plugin</Badge>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  Self-hosted FreeSWITCH pipeline
                                </p>
                              </div>
                              {formData.telephonyProvider === "custom-voice-engine" && (
                                <Check className="h-4 w-4 text-indigo-600" />
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
  );
}
