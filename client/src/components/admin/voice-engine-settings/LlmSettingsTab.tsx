
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Brain } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { ProviderSettings, ProviderKeyCard } from "@/components/admin/voice-engine-settings/shared";

export interface LlmSettingsTabProps {
  settings: ProviderSettings;
  updateMutation: UseMutationResult<any, any, Record<string, any>, unknown>;
  testProvider: (provider: string) => Promise<void>;
  testingProvider: string;
  testResults: Record<string, { connected: boolean; details: string; }>;
  isDemoMode: boolean;
  toast: ReturnType<typeof useToast>["toast"];
  isOrModelsLoading: boolean;
  orSearch: string;
  setOrSearch: Dispatch<SetStateAction<string>>;
  orModels: { id: string; name: string; context_length: number; }[];
}

export function LlmSettingsTab({ settings, updateMutation, testProvider, testingProvider, testResults, isDemoMode, toast, isOrModelsLoading, orSearch, setOrSearch, orModels }: LlmSettingsTabProps) {
  return (
    <TabsContent value="llm" className="space-y-6 mt-4">
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Provider API Keys</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
                <ProviderKeyCard provider="openrouter" label="OpenRouter API Key"
                  hasKey={settings.llm.providers.openrouter?.hasKey ?? false}
                  currentMasked={settings.llm.providers.openrouter?.maskedKey ?? ""}
                  onSave={(key) => updateMutation.mutate({ openrouterApiKey: key })}
                  onTest={() => testProvider("openrouter")}
                  isTesting={testingProvider === "openrouter"}
                  testResult={testResults.openrouter ?? null}
                  isDemoMode={isDemoMode} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Brain className="h-5 w-5 text-indigo-500" />
                <CardTitle className="text-base">Language Model Settings</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-6">
                <div className="flex flex-wrap gap-8">
                  <div className="space-y-2 border p-4 rounded-lg bg-muted/20 flex-1 min-w-[280px]">
                    <Label className="text-sm font-semibold">Active LLM Provider</Label>
                    <p className="text-xs text-muted-foreground mb-2">The primary provider for text generation.</p>
                    <Select
                      value={settings.llm.activeProvider}
                      onValueChange={(v) => {
                        if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing provider settings is disabled in demo mode.", variant: "destructive" }); return; }
                        updateMutation.mutate({ llmActiveProvider: v });
                      }}
                      disabled={isDemoMode}
                    >
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openrouter">OpenRouter</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2 border p-4 rounded-lg bg-muted/20 flex-1 min-w-[280px]">
                    <Label className="text-sm font-semibold">Default Model for OpenRouter</Label>
                    <p className="text-xs text-muted-foreground mb-2">Fallback model if an agent doesn't specify one.</p>
                    <Select
                      value={settings.llm.defaultModel}
                      onValueChange={(v) => {
                        if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing model settings is disabled in demo mode.", variant: "destructive" }); return; }
                        updateMutation.mutate({ llmDefaultModel: v });
                      }}
                      disabled={isDemoMode}
                    >
                      <SelectTrigger className="w-full">
                        {isOrModelsLoading ? (
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Loading models...
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
                  </div>
                </div>

                <div className="mt-2 p-4 rounded-xl border border-indigo-100/80 dark:border-indigo-950/60 bg-indigo-50/20 dark:bg-indigo-950/10 space-y-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                    <Brain className="h-4 w-4" />
                    <span>LLM Cost Tiers & Recommendation Guide</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Choose the best model based on your budget and requirements. Lower latency models are recommended for fast-paced voice conversations. INR rates calculated at ₹95/USD.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg bg-background border border-indigo-100/50 dark:border-indigo-950/40">
                      <div className="flex items-center justify-between mb-1.5">
                        <Badge variant="outline" className="text-[10px] font-bold text-emerald-600 border-emerald-300 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/20">Low Cost</Badge>
                        <div className="text-right">
                          <span className="text-[10px] block font-mono text-muted-foreground font-semibold">~$0.002 - $0.005/min</span>
                          <span className="text-[9px] block font-mono text-emerald-600 font-medium">(₹0.19 - ₹0.48/min)</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <strong>Flash & Mini Models</strong> (e.g. <code>gpt-4o-mini</code>, <code>gemini-2.5-flash</code>, <code>gemini-2.0-flash-lite</code>, <code>claude-3-haiku</code>, <code>llama-3.1-8b</code>, <code>deepseek-chat</code>). Ultra-fast response times, highly cost-effective, and ideal for standard high-concurrency conversational flows.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-background border border-indigo-100/50 dark:border-indigo-950/40">
                      <div className="flex items-center justify-between mb-1.5">
                        <Badge variant="outline" className="text-[10px] font-bold text-amber-600 border-amber-300 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/20">Mid Cost</Badge>
                        <div className="text-right">
                          <span className="text-[10px] block font-mono text-muted-foreground font-semibold">~$0.006 - $0.015/min</span>
                          <span className="text-[9px] block font-mono text-amber-600 font-medium">(₹0.57 - ₹1.43/min)</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <strong>Standard Models</strong> (e.g. <code>llama-3.1-70b</code>, <code>gemini-2.5-pro</code>, <code>mistral-large</code>, <code>qwen-2.5-72b</code>). Offers balanced intelligence, solid reasoning capability, and moderate pricing suitable for most business logic.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-background border border-indigo-100/50 dark:border-indigo-950/40">
                      <div className="flex items-center justify-between mb-1.5">
                        <Badge variant="outline" className="text-[10px] font-bold text-violet-600 border-violet-300 dark:border-violet-800 bg-violet-50/30 dark:bg-violet-950/20">Upper Cost</Badge>
                        <div className="text-right">
                          <span className="text-[10px] block font-mono text-muted-foreground font-semibold">~$0.02 - $0.06+/min</span>
                          <span className="text-[9px] block font-mono text-violet-600 font-medium">(₹1.90 - ₹5.70+/min)</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <strong>Pro & Sonnet Models</strong> (e.g. <code>gpt-4o</code>, <code>claude-3.5-sonnet</code>, <code>gpt-4-turbo</code>, <code>claude-3-opus</code>). Premium reasoning, advanced tool calling, structured JSON output, and complex multi-step execution.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 pt-2 border-t">
                  <Label className="text-sm font-semibold">Allowed Models (Available for Agents)</Label>
                  <p className="text-xs text-muted-foreground -mt-2">Check the models you want to expose in the Agent creation workflow.</p>
                  <div className="border rounded-md overflow-hidden flex flex-col h-[320px] w-full max-w-[800px] bg-background shadow-sm">
                    <div className="p-2 border-b bg-muted/30">
                      <Input
                        placeholder="Search models (Gemini, OpenRouter...)..."
                        value={orSearch}
                        onChange={(e) => setOrSearch(e.target.value)}
                        className="h-8 text-sm bg-background border-muted"
                      />
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                      {isOrModelsLoading ? (
                        <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground text-sm">
                          <Loader2 className="h-4 w-4 animate-spin" /> Fetching models...
                        </div>
                      ) : (
                        (() => {
                          const staticGeminiModels: Array<{ id: string; name: string }> = [];
                          const allLlmModels = [
                            ...staticGeminiModels,
                            ...orModels
                          ];
                          const filtered = allLlmModels
                            .filter((m) =>
                              m.name.toLowerCase().includes(orSearch.toLowerCase()) ||
                              m.id.toLowerCase().includes(orSearch.toLowerCase())
                            )
                            .sort((a, b) => {
                              const aSelected = settings.llm.allowedModels?.includes(a.id) ? 1 : 0;
                              const bSelected = settings.llm.allowedModels?.includes(b.id) ? 1 : 0;
                              if (aSelected !== bSelected) return bSelected - aSelected;
                              return a.name.localeCompare(b.name);
                            });

                          if (filtered.length === 0) {
                            return <div className="text-center py-4 text-sm text-muted-foreground">No models found.</div>;
                          }

                          return filtered.slice(0, 100).map((m) => {
                            const isSelected = settings.llm.allowedModels?.includes(m.id) ?? false;
                            return (
                              <div
                                key={m.id}
                                className={`flex items-center space-x-3 rounded-md p-2 transition-colors cursor-pointer border border-transparent ${isSelected ? 'bg-indigo-50/50 dark:bg-indigo-950/20 border-indigo-100 dark:border-indigo-900/30' : 'hover:bg-muted/50'}`}
                                onClick={() => {
                                  const currentAllowed = settings.llm.allowedModels || [];
                                  const newAllowed = !isSelected
                                    ? [...currentAllowed, m.id]
                                    : currentAllowed.filter(id => id !== m.id);
                                  updateMutation.mutate({ llmAllowedModels: newAllowed });
                                }}
                              >
                                <Checkbox
                                  id={`model-${m.id}`}
                                  checked={isSelected}
                                  className={isSelected ? "data-[state=checked]:bg-indigo-600 data-[state=checked]:border-indigo-600" : ""}
                                  onCheckedChange={(checked) => {
                                    const currentAllowed = settings.llm.allowedModels || [];
                                    const newAllowed = checked
                                      ? [...currentAllowed, m.id]
                                      : currentAllowed.filter(id => id !== m.id);
                                    updateMutation.mutate({ llmAllowedModels: newAllowed });
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <label htmlFor={`model-${m.id}`} className="flex flex-col cursor-pointer flex-1" onClick={(e) => e.stopPropagation()}>
                                  <span className={`text-sm font-medium leading-none ${isSelected ? 'text-indigo-900 dark:text-indigo-300' : ''}`}>{m.name}</span>
                                  <span className="text-[10px] text-muted-foreground font-mono mt-1">{m.id}</span>
                                </label>
                              </div>
                            );
                          });
                        })()
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
  );
}
