import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Phone, Loader2, Globe, Volume2, Cpu } from "lucide-react";
import { AuthStorage } from "@/lib/auth-storage";
import CVEVoicePreviewButton from "@/components/CVEVoicePreviewButton";
import { apiRequest } from "@/lib/queryClient";

const COUNTRY_CODES = [
  { label: "🇮🇳 India (+91)", value: "+91" },
  { label: "🇺🇸 United States (+1)", value: "+1" },
  { label: "🇬🇧 United Kingdom (+44)", value: "+44" },
  { label: "🇨🇦 Canada (+1)", value: "+1" },
  { label: "🇦🇺 Australia (+61)", value: "+61" },
  { label: "🇩🇪 Germany (+49)", value: "+49" },
  { label: "🇫🇷 France (+33)", value: "+33" },
  { label: "🇪🇸 Spain (+34)", value: "+34" },
  { label: "🇧🇷 Brazil (+55)", value: "+55" },
  { label: "🇯🇵 Japan (+81)", value: "+81" },
  { label: "🇸🇬 Singapore (+65)", value: "+65" },
  { label: "🇦🇪 UAE (+971)", value: "+971" },
];

const LANGUAGES = [
  { label: "Default (Agent Config)", value: "default" },
  { label: "English", value: "en" },
  { label: "Hindi", value: "hi" },
  { label: "Tamil", value: "ta" },
  { label: "Telugu", value: "te" },
  { label: "Spanish", value: "es" },
  { label: "French", value: "fr" },
  { label: "German", value: "de" },
  { label: "Bengali", value: "bn" },
  { label: "Kannada", value: "kn" },
];

const AUDIO_VOICES = [
  { label: "Default (Agent Config)", value: "default", provider: "default", voice: "default" },
  // Deepgram
  { label: "Deepgram - Asteria (Female English)", value: "dg:aura-asteria-en", provider: "deepgram", voice: "aura-asteria-en" },
  { label: "Deepgram - Luna (Female English)", value: "dg:aura-luna-en", provider: "deepgram", voice: "aura-luna-en" },
  { label: "Deepgram - Orion (Male English)", value: "dg:aura-orion-en", provider: "deepgram", voice: "aura-orion-en" },
  { label: "Deepgram - Helios (Male English)", value: "dg:aura-helios-en", provider: "deepgram", voice: "aura-helios-en" },
  // Sarvam
  { label: "Sarvam - Neha (Female Hindi/Indian)", value: "sv:neha", provider: "sarvam", voice: "neha" },
  { label: "Sarvam - Priya (Female Hindi/Indian)", value: "sv:priya", provider: "sarvam", voice: "priya" },
  { label: "Sarvam - Amit (Male Hindi/Indian)", value: "sv:amit", provider: "sarvam", voice: "amit" },
];

const LLM_MODELS = [
  { label: "Default (Agent Config)", value: "default" },
  { label: "OpenAI GPT-4o Mini", value: "openai/gpt-4o-mini" },
  { label: "Google Gemini 2.5 Flash", value: "google/gemini-2.5-flash" },
  { label: "Anthropic Claude 3.5 Sonnet", value: "anthropic/claude-3.5-sonnet" },
  { label: "Meta Llama 3.1 70B", value: "meta-llama/llama-3.1-70b-instruct" },
];

export function CveTestCallWidget() {
  const { toast } = useToast();
  const isAuthenticated = AuthStorage.isAuthenticated();
  const [countryCode, setCountryCode] = useState<string>("+91");
  const [phoneNumber, setPhoneNumber] = useState<string>("default");
  const [language, setLanguage] = useState<string>("default");
  const [voiceValue, setVoiceValue] = useState<string>("default");
  const [llmModel, setLlmModel] = useState<string>("default");
  const [isCalling, setIsCalling] = useState<boolean>(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [callStage, setCallStage] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSessionId) return;

    let timer: NodeJS.Timeout;
    const pollStatus = async () => {
      try {
        const endpoint = isAuthenticated
          ? `/api/voice-engine/calls/${activeSessionId}`
          : `/api/public/voice-engine/calls/${activeSessionId}`;
        
        let res;
        if (isAuthenticated) {
          res = await apiRequest("GET", endpoint);
        } else {
          res = await fetch(endpoint);
        }
        
        const json = await res.json();
        if (json.success && json.data) {
          const status = json.data.status;
          setCallStage(status);
          
          if (["completed", "ended", "failed", "busy", "no-answer"].includes(status)) {
            setActiveSessionId(null);
            setIsCalling(false);
          } else {
            timer = setTimeout(pollStatus, 1500);
          }
        }
      } catch (err) {
        console.error("Error polling call status:", err);
      }
    };

    timer = setTimeout(pollStatus, 1000);
    return () => clearTimeout(timer);
  }, [activeSessionId, isAuthenticated]);

  const handleStartCall = async () => {
    if (!phoneNumber || phoneNumber === "default") {
      toast({
        title: "Phone Number Required",
        description: "Please enter a phone number to call.",
        variant: "destructive",
      });
      return;
    }

    setIsCalling(true);
    setCallStage("initiating");

    try {
      const selectedVoiceObj = AUDIO_VOICES.find(v => v.value === voiceValue);
      const hasVoiceOverride = selectedVoiceObj && selectedVoiceObj.value !== "default";
      const fullPhoneNumber = `${countryCode}${phoneNumber.replace(/^\+/, "").replace(/\D/g, "")}`;

      const payload: Record<string, any> = {
        toNumber: fullPhoneNumber,
        fromNumber: "FreeSWITCH",
      };

      if (language !== "default") payload.language = language;
      if (llmModel !== "default") payload.llmModel = llmModel;
      if (hasVoiceOverride) {
        payload.ttsProvider = selectedVoiceObj.provider;
        payload.ttsVoice = selectedVoiceObj.voice;
        if (selectedVoiceObj.provider === "sarvam") {
          payload.sttProvider = "sarvam";
          payload.sttModel = "saaras:v3";
          payload.ttsModel = "bulbul:v3";
        } else if (selectedVoiceObj.provider === "deepgram") {
          payload.sttProvider = "deepgram";
          payload.sttModel = "nova-2";
          payload.ttsModel = "aura-asteria-en";
        }
      }

      let res;
      if (isAuthenticated) {
        res = await apiRequest("POST", "/api/voice-engine/calls/outbound", payload);
      } else {
        res = await fetch("/api/public/voice-engine/calls/outbound", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errText = await res.text();
          let errData;
          try {
            errData = JSON.parse(errText);
          } catch {
            // ignore
          }
          throw new Error(errData?.error || errText || "Failed to trigger outbound call");
        }
      }

      const data = await res.json();

      if (data.success) {
        toast({
          title: "Call Initiated",
          description: `Outbound test call triggered successfully to ${fullPhoneNumber}.`,
        });
        setActiveSessionId(data.data.id);
        setPhoneNumber("");
      } else {
        throw new Error(data.error || "Failed to trigger outbound call");
      }
    } catch (err: any) {
      toast({
        title: "Call Failed",
        description: err.message || "An error occurred while placing the call.",
        variant: "destructive",
      });
      setCallStage("failed");
      setIsCalling(false);
    }
  };

  return (
    <Card className="shadow-lg border-primary/10 bg-gradient-to-br from-card to-background">
      <CardHeader className="pb-3 border-b border-primary/5">
        <CardTitle className="text-base font-semibold flex items-center gap-2 text-foreground">
          <Phone className="h-4 w-4 text-primary animate-pulse" />
          Test Outbound Call
        </CardTitle>
        <CardDescription>
          Initiate direct calls powered by the Custom Voice Engine.
        </CardDescription>
      </CardHeader>

      <CardContent className="pt-4 space-y-4">
        {/* Country Code & Phone Input */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            <Phone className="h-3 w-3" /> Phone Number
          </label>
          <div className="flex gap-2">
            <Select value={countryCode} onValueChange={setCountryCode}>
              <SelectTrigger className="w-[140px] h-9">
                <SelectValue placeholder="Code" />
              </SelectTrigger>
              <SelectContent>
                {COUNTRY_CODES.map((code) => (
                  <SelectItem key={code.label} value={code.value}>
                    {code.label.split(" ")[0]} {code.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="tel"
              placeholder="e.g. 9876543210"
              value={phoneNumber === "default" ? "" : phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              className="h-9 flex-1"
            />
          </div>
        </div>

        {/* Grid for Quick Overrides */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Language Select */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
              <Globe className="h-3 w-3" /> Language
            </label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Language" />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((lang) => (
                  <SelectItem key={lang.value} value={lang.value}>
                    {lang.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Voice/Audio Select */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
              <Volume2 className="h-3 w-3" /> Audio Option
            </label>
            <div className="flex gap-2">
              <Select value={voiceValue} onValueChange={setVoiceValue}>
                <SelectTrigger className="h-9 flex-1">
                  <SelectValue placeholder="Voice" />
                </SelectTrigger>
                <SelectContent>
                  {AUDIO_VOICES.map((voice) => (
                    <SelectItem key={voice.value} value={voice.value}>
                      {voice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {voiceValue !== "default" && (
                <CVEVoicePreviewButton
                  voiceId={AUDIO_VOICES.find((v) => v.value === voiceValue)?.voice || null}
                  provider={AUDIO_VOICES.find((v) => v.value === voiceValue)?.provider}
                  language={language !== "default" ? language : undefined}
                />
              )}
            </div>
          </div>

          {/* LLM Model Select */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
              <Cpu className="h-3 w-3" /> LLM Model
            </label>
            <Select value={llmModel} onValueChange={setLlmModel}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="LLM Model" />
              </SelectTrigger>
              <SelectContent>
                {LLM_MODELS.map((model) => (
                  <SelectItem key={model.value} value={model.value}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Start Call Button */}
        <Button
          onClick={handleStartCall}
          disabled={isCalling}
          className="w-full h-10 mt-2 bg-gradient-to-r from-primary to-primary/80 hover:from-primary/95 hover:to-primary/85 text-white font-medium shadow-md transition-all flex items-center justify-center gap-2"
        >
          {isCalling ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Placing Call...
            </>
          ) : (
            <>
              <Phone className="h-4 w-4" />
              Start Test Call
            </>
          )}
        </Button>

        {/* Real-time Call Stage indicator */}
        {callStage && (
          <div className="mt-2 p-3 rounded-lg border border-primary/10 bg-primary/5 flex items-center justify-between text-sm animate-pulse-subtle">
            <div className="flex items-center gap-2">
              <span className="flex h-2.5 w-2.5 relative">
                {["initializing", "active"].includes(callStage) && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                )}
                <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                  callStage === "active" ? "bg-emerald-500" :
                  callStage === "initializing" ? "bg-amber-500" :
                  ["completed", "ended"].includes(callStage) ? "bg-muted-foreground" : "bg-rose-500"
                }`}></span>
              </span>
              <span className="font-semibold text-foreground capitalize">
                {callStage === "initializing" ? "Dialing / Routing..." :
                 callStage === "active" ? "Call Answered / Speaking..." :
                 ["completed", "ended"].includes(callStage) ? "Call Completed" : `Call ${callStage}`}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {["initializing", "active"].includes(callStage) ? "Connected" : "Disconnected"}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
