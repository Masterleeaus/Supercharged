
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { Copy, Check, Info } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

export interface TelephonySettingsTabProps {
  selectedSipProvider: string;
  setSelectedSipProvider: Dispatch<SetStateAction<string>>;
  sipTemplates: Record<string, { guide: string; gatewayXml: string; }>;
  handleCopy: (text: string, label: string) => void;
  copiedText: string;
  dialplanXml: "<extension name=\"ai_voice_agent\">\n  <condition field=\"destination_number\" expression=\"^(\\+?\\d+)$\">\n    <action application=\"answer\"/>\n    <action application=\"playback\" data=\"silence_stream://500\"/>\n    <action application=\"set\" data=\"tts_engine=flite\"/>\n    <action application=\"set\" data=\"tts_voice=slt\"/>\n    <!-- Stream audio to voice-engine plugin WebSocket server -->\n    <action application=\"audio_fork\" data=\"start ws://<your-node-ip>:8089/voice-engine/ws/audio/${uuid}\"/>\n    <action application=\"park\"/>\n  </condition>\n</extension>";
}

export function TelephonySettingsTab({ selectedSipProvider, setSelectedSipProvider, sipTemplates, handleCopy, copiedText, dialplanXml }: TelephonySettingsTabProps) {
  return (
    <TabsContent value="telephony" className="space-y-4 mt-4">
          <Card className="border border-indigo-100 dark:border-indigo-950 bg-indigo-50/20 dark:bg-indigo-950/10">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Info className="h-5 w-5 text-indigo-500" />
                <CardTitle className="text-lg text-indigo-900 dark:text-indigo-200">Decoupled Telephony Architecture</CardTitle>
              </div>
              <CardDescription>
                The Custom Voice Engine decouples telephony from the AI pipeline. Your SIP Providers send/receive calls through <strong>FreeSWITCH</strong> directly. FreeSWITCH streams live audio to this backend over WebSockets.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 items-center justify-between text-sm py-2 px-3 bg-background rounded-lg border border-border/80">
                <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                  <Badge variant="outline">SIP Provider</Badge>
                  <span>→</span>
                  <Badge variant="secondary">FreeSWITCH Node</Badge>
                  <span>→</span>
                  <Badge className="bg-indigo-600">mod_audio_fork</Badge>
                  <span>→</span>
                  <Badge variant="secondary">WebSocket (Port 8089)</Badge>
                  <span>→</span>
                  <Badge className="bg-indigo-600">AI Voice Engine</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <Card>
                <CardHeader>
                  <div className="flex justify-between items-center">
                    <CardTitle className="text-base">1. Configure Your SIP Provider Gateway</CardTitle>
                    <Select value={selectedSipProvider} onValueChange={setSelectedSipProvider}>
                      <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="twilio">Twilio</SelectItem>
                        <SelectItem value="telnyx">Telnyx</SelectItem>
                        <SelectItem value="plivo">Plivo</SelectItem>
                        <SelectItem value="vonage">Vonage</SelectItem>
                        <SelectItem value="bandwidth">Bandwidth</SelectItem>
                        <SelectItem value="sinch">Sinch</SelectItem>
                        <SelectItem value="infobip">Infobip</SelectItem>
                        <SelectItem value="agora">Agora</SelectItem>
                        <SelectItem value="restcomm">Restcomm</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <CardDescription className="text-xs mt-1 whitespace-pre-line leading-relaxed">
                    {sipTemplates[selectedSipProvider].guide}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-xs font-semibold">
                      FreeSWITCH Gateway configuration file (<span className="font-mono text-indigo-500">conf/sip_profiles/external/{selectedSipProvider}.xml</span>)
                    </Label>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleCopy(sipTemplates[selectedSipProvider].gatewayXml, "gateway")}>
                      {copiedText === "gateway" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                  <pre className="text-xs bg-muted/60 p-3 rounded-lg overflow-x-auto font-mono max-h-[200px] border">
                    <code>{sipTemplates[selectedSipProvider].gatewayXml}</code>
                  </pre>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">2. Configure Inbound Routing (Dialplan)</CardTitle>
                  <CardDescription>
                    Add this extension xml block inside your FreeSWITCH Dialplan directory (<span className="font-mono text-indigo-500">conf/dialplan/public/*.xml</span>) to bridge inbound SIP trunk calls directly into the AI pipeline.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-xs font-semibold">FreeSWITCH Dialplan snippet (<span className="font-mono text-indigo-500">dialplan.xml</span>)</Label>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleCopy(dialplanXml, "dialplan")}>
                      {copiedText === "dialplan" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                  <pre className="text-xs bg-muted/60 p-3 rounded-lg overflow-x-auto font-mono max-h-[260px] border">
                    <code>{dialplanXml}</code>
                  </pre>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader><CardTitle className="text-base">Quick Telephony Checklist</CardTitle></CardHeader>
                <CardContent className="text-xs space-y-3 leading-relaxed text-muted-foreground">
                  {[
                    'Register at least one FreeSWITCH node in the "FreeSWITCH Nodes" tab on this settings page.',
                    'Load the mod_audio_fork module in your FreeSWITCH instance to stream audio over WebSockets.',
                    'Add the Gateway profile configuration from the left to register FreeSWITCH to your provider.',
                    "Map your inbound DID numbers in the dialplan to start audio_fork to this server's WebSocket url.",
                  ].map((text, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="h-5 w-5 shrink-0 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-800">{i + 1}</div>
                      <p>{text}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">Why decouplable?</CardTitle></CardHeader>
                <CardContent className="text-xs leading-relaxed text-muted-foreground space-y-2">
                  <p>By keeping the SIP layer on FreeSWITCH, the Custom Voice Engine isn't locked into any specific phone vendor.</p>
                  <p>You can mix-and-match carriers (e.g. use Telnyx for SMS, Twilio for UK numbers, Plivo for Indian DIDs) and load-balance them seamlessly across your FreeSWITCH clusters.</p>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
  );
}
