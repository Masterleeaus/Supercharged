
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { Mic, Volume2, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { UseMutationResult } from "@tanstack/react-query";
import { ProviderSettings, ProviderKeyCard } from "@/components/admin/voice-engine-settings/shared";

export interface SpeechSettingsTabProps {
  settings: ProviderSettings;
  updateMutation: UseMutationResult<any, any, Record<string, any>, unknown>;
  testProvider: (provider: string) => Promise<void>;
  testingProvider: string;
  testResults: Record<string, { connected: boolean; details: string; }>;
  isDemoMode: boolean;
  toast: ReturnType<typeof useToast>["toast"];
}

export function SpeechSettingsTab({ settings, updateMutation, testProvider, testingProvider, testResults, isDemoMode, toast }: SpeechSettingsTabProps) {
  return (
    <TabsContent value="speech" className="space-y-6 mt-4">
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Provider API Keys</CardTitle>
              <CardDescription className="text-xs">Shared between STT and TTS</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ProviderKeyCard provider="deepgram" label="Deepgram API Key"
                  hasKey={settings.stt.providers.deepgram?.hasKey ?? false}
                  currentMasked={settings.stt.providers.deepgram?.maskedKey ?? ""}
                  onSave={(key) => updateMutation.mutate({ deepgramApiKey: key })}
                  onTest={() => testProvider("deepgram")}
                  isTesting={testingProvider === "deepgram"}
                  testResult={testResults.deepgram ?? null}
                  isDemoMode={isDemoMode} />
                <ProviderKeyCard provider="sarvam" label="Sarvam AI API Key"
                  hasKey={settings.stt.providers.sarvam?.hasKey ?? false}
                  currentMasked={settings.stt.providers.sarvam?.maskedKey ?? ""}
                  onSave={(key) => updateMutation.mutate({ sarvamApiKey: key })}
                  onTest={() => testProvider("sarvam")}
                  isTesting={testingProvider === "sarvam"}
                  testResult={testResults.sarvam ?? null}
                  isDemoMode={isDemoMode} />
{/* <ProviderKeyCard provider="elevenlabs" label="ElevenLabs API Key"
                  hasKey={settings.tts.providers.elevenlabs?.hasKey ?? false}
                  currentMasked={settings.tts.providers.elevenlabs?.maskedKey ?? ""}
                  onSave={(key) => updateMutation.mutate({ elevenlabsApiKey: key })}
                  onTest={() => testProvider("elevenlabs")}
                  isTesting={testingProvider === "elevenlabs"}
                  testResult={testResults.elevenlabs ?? null}
                  isDemoMode={isDemoMode} /> */}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Mic className="h-5 w-5 text-indigo-500" />
                <CardTitle className="text-base">Speech-to-Text (STT)</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-6">
                <div className="space-y-3">
                  <Label className="text-sm font-semibold">Allowed STT Providers</Label>
                  <p className="text-xs text-muted-foreground -mt-2">Select which providers are available for speech-to-text.</p>
                  <div className="grid grid-cols-2 gap-4">
                    {['deepgram', 'sarvam'].map(provider => {
                      const sttAllowed = settings.stt.allowedProviders || ['deepgram'];
                      const isChecked = sttAllowed.includes(provider);
                      return (
                        <div
                          key={provider}
                          className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${isChecked
                            ? "border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/20"
                            : "border-border hover:border-indigo-400/50 hover:bg-indigo-500/5"
                            }`}
                          onClick={() => {
                            if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing provider settings is disabled in demo mode.", variant: "destructive" }); return; }
                            let newAllowed = [...sttAllowed];
                            if (isChecked) {
                              if (newAllowed.length <= 1) return; // Need at least 1
                              newAllowed = newAllowed.filter(p => p !== provider);
                            } else {
                              newAllowed.push(provider);
                            }
                            updateMutation.mutate({
                              sttAllowedProviders: newAllowed,
                              ...(!newAllowed.includes(settings.stt.activeProvider) && { sttActiveProvider: newAllowed[0] })
                            });
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold">{provider === 'deepgram' ? 'Deepgram' : 'Sarvam AI'}</div>
                            </div>
                            {isChecked && <Check className="h-4 w-4 text-indigo-600" />}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {provider === 'deepgram' ? 'Fast, accurate STT models' : 'Specialized Indic language models'}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Default Models for each allowed provider */}
                  {(settings.stt.allowedProviders || ['deepgram']).map(provider => {
                    const isDeepgram = provider === 'deepgram';
                    const models = isDeepgram
                      ? [
                        { value: 'nova-2', label: 'Deepgram Nova-2 (General)' },
                        { value: 'nova-2-phonecall', label: 'Deepgram Nova-2 (Phone)' },
                        { value: 'nova-2-medical', label: 'Deepgram Nova-2 (Medical)' },
                        { value: 'nova-3', label: 'Deepgram Nova-3' },
                        { value: 'base', label: 'Deepgram Base' },
                        // { value: 'enhanced', label: 'Deepgram Enhanced' }
                      ]
                      : [
                        { value: 'saaras:v3', label: 'Saaras V3' },
                        { value: 'saarika:v2.5', label: 'Saarika V2.5' },
                        // { value: 'saaras:v3-realtime', label: 'Saaras V3 Realtime' },
                        // { value: 'saarika:v2', label: 'Saarika V2' },
                        // { value: 'saarika:v1', label: 'Saarika V1' },
                        // { value: 'saarika:flash', label: 'Saarika Flash' }
                      ];

                    const allowedModels = isDeepgram ? (settings.stt.deepgramAllowedModels || ['nova-2', 'nova-2-phonecall']) : (settings.stt.sarvamAllowedModels || ['saaras:v3']);

                    return (
                      <div key={`stt-model-${provider}`} className="space-y-4 border rounded-md p-4 bg-muted/20">
                        <div className="space-y-2">
                          <Label>Default Model ({isDeepgram ? 'Deepgram' : 'Sarvam'})</Label>
                          <Select
                            value={isDeepgram ? (settings.stt.deepgramModel || "") : (settings.stt.sarvamModel || "")}
                            onValueChange={(v) => updateMutation.mutate(isDeepgram ? { sttDeepgramModel: v } : { sttSarvamModel: v })}>
                            <SelectTrigger className="w-full"><SelectValue placeholder="Select a model" /></SelectTrigger>
                            <SelectContent>
                              {models.map(m => (
                                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-4 pt-4 border-t">
                          <div>
                            <Label className="text-sm font-semibold">Allowed Models for Agents</Label>
                            <p className="text-xs text-muted-foreground mb-3">Select which models are available to users</p>
                            <div className="flex flex-wrap gap-2">
                              {models.map(m => {
                                const isAllowed = allowedModels.includes(m.value);
                                return (
                                  <Badge
                                    key={m.value}
                                    variant={isAllowed ? "default" : "outline"}
                                    className={`cursor-pointer px-3 py-1.5 transition-all ${isAllowed ? 'bg-indigo-600 hover:bg-indigo-700' : 'text-muted-foreground hover:text-foreground'}`}
                                    onClick={() => {
                                      let newAllowed = [...allowedModels];
                                      if (isAllowed) {
                                        if (newAllowed.length <= 1) return; // need at least 1
                                        newAllowed = newAllowed.filter(x => x !== m.value);
                                      } else {
                                        newAllowed.push(m.value);
                                      }
                                      updateMutation.mutate(
                                        isDeepgram
                                          ? { sttDeepgramAllowedModels: newAllowed }
                                          : { sttSarvamAllowedModels: newAllowed }
                                      );
                                    }}
                                  >
                                    {isAllowed && <Check className="h-3 w-3 mr-1.5 inline-block" />}
                                    {m.label}
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Volume2 className="h-5 w-5 text-indigo-500" />
                <CardTitle className="text-base">Text-to-Speech (TTS)</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-6">
                <div className="space-y-3">
                  <Label className="text-sm font-semibold">Allowed TTS Providers</Label>
                  <p className="text-xs text-muted-foreground -mt-2">Select which providers are available for text-to-speech.</p>
                  <div className="grid grid-cols-2 gap-4">
                    {['deepgram', 'sarvam'].map(provider => {
                      const ttsAllowed = settings.tts.allowedProviders || ['deepgram'];
                      const isChecked = ttsAllowed.includes(provider);
                      const getDisplayName = (p: string) => {
                        if (p === 'deepgram') return 'Deepgram';
                        if (p === 'sarvam') return 'Sarvam AI';
                        return 'ElevenLabs';
                      };
                      const getDescription = (p: string) => {
                        if (p === 'deepgram') return 'High quality, low latency voices';
                        if (p === 'sarvam') return 'Expressive Indic voices';
                        return 'Ultra-realistic conversational voices';
                      };
                      return (
                        <div
                          key={provider}
                          className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${isChecked
                            ? "border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/20"
                            : "border-border hover:border-indigo-400/50 hover:bg-indigo-500/5"
                            }`}
                          onClick={() => {
                            let newAllowed = [...ttsAllowed];
                            if (isChecked) {
                              if (newAllowed.length <= 1) return; // Need at least 1
                              newAllowed = newAllowed.filter(p => p !== provider);
                            } else {
                              newAllowed.push(provider);
                            }
                            updateMutation.mutate({
                              ttsAllowedProviders: newAllowed,
                              ...(!newAllowed.includes(settings.tts.activeProvider) && { ttsActiveProvider: newAllowed[0] })
                            });
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold">{getDisplayName(provider)}</div>
                            </div>
                            {isChecked && <Check className="h-4 w-4 text-indigo-600" />}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {getDescription(provider)}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Default Models for each allowed provider */}
                  {(settings.tts.allowedProviders || ['deepgram']).map(provider => {
                    const isDeepgram = provider === 'deepgram';
                    const models = isDeepgram
                      ? [
                        { value: 'aura-2', label: 'Deepgram Aura 2' },
                        { value: 'aura', label: 'Deepgram Aura' }
                      ]
                      : [
                        { value: 'bulbul:v3', label: 'Sarvam Bulbul V3' },
                        { value: 'bulbul:v2', label: 'Sarvam Bulbul V2' }
                      ];

                    const allowedModelsRaw = isDeepgram
                      ? (settings.tts.deepgramAllowedModels || ['aura-2', 'aura'])
                      : provider === 'sarvam'
                        ? (settings.tts.sarvamAllowedModels || ['bulbul:v3', 'bulbul:v2'])
                        : ((settings.tts as any).elevenlabsAllowedModels || ['eleven_turbo_v2_5', 'eleven_turbo_v2']);

                    const allowedModels = isDeepgram
                      ? Array.from(new Set(allowedModelsRaw.map((x: string) => x.startsWith('aura-2') ? 'aura-2' : 'aura')))
                      : allowedModelsRaw;

                    const getModelValue = (val: string) => {
                      if (provider === 'deepgram') {
                        if (!val) return "aura-2";
                        if (val.startsWith("aura-2")) return "aura-2";
                        if (val.startsWith("aura")) return "aura";
                        return val;
                      }
                      if (provider === 'sarvam') return val || "bulbul:v3";
                      return val || "eleven_turbo_v2_5";
                    };

                    return (
                      <div key={`tts-model-${provider}`} className="space-y-4 border rounded-md p-4 bg-muted/20">
                        <div className="space-y-2">
                          <Label>Default Voice Model ({provider === 'deepgram' ? 'Deepgram' : provider === 'sarvam' ? 'Sarvam' : 'ElevenLabs'})</Label>
                          <Select
                            value={provider === 'deepgram' ? getModelValue(settings.tts.deepgramModel || "") : provider === 'sarvam' ? (settings.tts.sarvamModel || "") : ((settings.tts as any).elevenlabsModel || "")}
                            onValueChange={(v) => updateMutation.mutate(provider === 'deepgram' ? { ttsDeepgramModel: v } : provider === 'sarvam' ? { ttsSarvamModel: v } : { ttsElevenlabsModel: v })}>
                            <SelectTrigger className="w-full"><SelectValue placeholder="Select a voice model" /></SelectTrigger>
                            <SelectContent>
                              {provider === 'deepgram' ? (
                                <>
                                  <SelectItem value="aura-2">Deepgram Aura 2</SelectItem>
                                  <SelectItem value="aura">Deepgram Aura</SelectItem>
                                </>
                              ) : provider === 'sarvam' ? (
                                <>
                                  <SelectItem value="bulbul:v3">Sarvam Bulbul V3</SelectItem>
                                  <SelectItem value="bulbul:v2">Sarvam Bulbul V2</SelectItem>
                                </>
                              ) : null}
                            </SelectContent>
                          </Select>
                        </div>
                        {/* 
                        <div className="space-y-4 pt-4 border-t">
                          <div>
                            <Label className="text-sm font-semibold">Allowed Models for Agents</Label>
                            <p className="text-xs text-muted-foreground mb-3">Select which models are available to users</p>
                            <div className="flex flex-wrap gap-2">
                              {(provider === 'deepgram' ? (
                                [
                                  { value: 'aura-2', label: 'Deepgram Aura 2' },
                                  { value: 'aura', label: 'Deepgram Aura' }
                                ]
                              ) : provider === 'sarvam' ? (
                                [
                                  { value: 'bulbul:v3', label: 'Sarvam Bulbul V3' },
                                  { value: 'bulbul:v2', label: 'Sarvam Bulbul V2' }
                                ]
                              ) : (
                                [
                                  { value: 'eleven_turbo_v2_5', label: 'Eleven Turbo v2.5' },
                                  { value: 'eleven_turbo_v2', label: 'Eleven Turbo v2' },
                                  { value: 'eleven_multilingual_v2', label: 'Eleven Multilingual v2' }
                                ]
                              )).map(m => {
                                const isAllowed = allowedModels.includes(m.value);
                                return (
                                  <Badge
                                    key={m.value}
                                    variant={isAllowed ? "default" : "outline"}
                                    className={`cursor-pointer px-3 py-1.5 transition-all ${isAllowed ? 'bg-indigo-600 hover:bg-indigo-700' : 'text-muted-foreground hover:text-foreground'}`}
                                    onClick={() => {
                                      if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing model settings is disabled in demo mode.", variant: "destructive" }); return; }
                                      let newAllowed = [...allowedModels];
                                      if (isAllowed) {
                                        if (newAllowed.length <= 1) return; // need at least 1
                                        newAllowed = newAllowed.filter(x => x !== m.value);
                                      } else {
                                        newAllowed.push(m.value);
                                      }
                                      updateMutation.mutate(
                                        provider === 'deepgram'
                                          ? { ttsDeepgramAllowedModels: newAllowed }
                                          : provider === 'sarvam'
                                          ? { ttsSarvamAllowedModels: newAllowed }
                                          : { ttsElevenlabsAllowedModels: newAllowed }
                                      );
                                    }}
                                  >
                                    {isAllowed && <Check className="h-3 w-3 mr-1.5 inline-block" />}
                                    {m.label}
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                        </div> */}
                      </div>
                    )
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

        </TabsContent>
  );
}
