import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mic, MicOff, Loader2, Play, Square, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface VoiceAgent {
  id: string;
  name: string;
  language: string;
}

const LANGUAGES = [
  { label: "English (US)", value: "en-US" },
  { label: "English (UK)", value: "en-GB" },
  { label: "Spanish", value: "es" },
  { label: "French", value: "fr" },
  { label: "German", value: "de" },
  { label: "Hindi", value: "hi" },
  { label: "Bengali", value: "bn" },
  { label: "Tamil", value: "ta" },
  { label: "Telugu", value: "te" },
  { label: "Marathi", value: "mr" },
  { label: "Gujarati", value: "gu" },
  { label: "Kannada", value: "kn" },
  { label: "Malayalam", value: "ml" },
  { label: "Punjabi", value: "pa" },
];

export default function SttTester() {
  const { toast } = useToast();
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedLanguage, setSelectedLanguage] = useState<string>("en-US");
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [interimTranscript, setInterimTranscript] = useState<string>("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const { data: agents } = useQuery<VoiceAgent[]>({
    queryKey: ["/api/voice-engine/agents"],
  });

  useEffect(() => {
    if (agents && agents.length > 0 && !selectedAgentId) {
      setSelectedAgentId(agents[0].id);
      setSelectedLanguage(agents[0].language || "en-US");
    }
  }, [agents]);

  const startTest = async () => {
    if (!selectedAgentId) return;
    
    setIsStarting(true);
    setTranscript("");
    setInterimTranscript("");
    
    try {
      const res = await apiRequest("POST", "/api/voice-engine/calls/simulator/start", {
        agentId: selectedAgentId,
        language: selectedLanguage,
      });
      
      const { sessionId, wsUrl } = await res.json();
      setSessionId(sessionId);
      
      // Initialize WebSocket
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const ws = new WebSocket(`${protocol}//${host}${wsUrl}`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket connected");
        startRecording();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "stt_transcript") {
            const { text, isFinal } = data.transcript;
            if (isFinal) {
              setTranscript((prev) => prev + " " + text);
              setInterimTranscript("");
            } else {
              setInterimTranscript(text);
            }
          }
        } catch (err) {
          // It might be binary audio data coming back from TTS
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        toast({ title: "WebSocket Error", variant: "destructive" });
        stopTest();
      };

      ws.onclose = () => {
        console.log("WebSocket closed");
        stopTest();
      };

    } catch (err: any) {
      toast({ title: "Failed to start test", description: err.message, variant: "destructive" });
      setIsStarting(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      
      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          // Convert Float32 to Int16
          const pcmData = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
          }
          wsRef.current.send(pcmData.buffer);
        }
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      setIsRecording(true);
      setIsStarting(false);
    } catch (err: any) {
      toast({ title: "Microphone Access Denied", description: err.message, variant: "destructive" });
      stopTest();
    }
  };

  const stopTest = () => {
    setIsRecording(false);
    setIsStarting(false);
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">STT Tester</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Select agent and language for testing</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Voice Agent</label>
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId} disabled={isRecording}>
                <SelectTrigger>
                  <SelectValue placeholder="Select Agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents?.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Language</label>
              <Select value={selectedLanguage} onValueChange={setSelectedLanguage} disabled={isRecording}>
                <SelectTrigger>
                  <SelectValue placeholder="Select Language" />
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

            <Button 
              className="w-full" 
              onClick={isRecording ? stopTest : startTest}
              variant={isRecording ? "destructive" : "default"}
              disabled={isStarting || !selectedAgentId}
            >
              {isStarting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting...</>
              ) : isRecording ? (
                <><Square className="mr-2 h-4 w-4" /> Stop Testing</>
              ) : (
                <><Play className="mr-2 h-4 w-4" /> Start Testing</>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Live Transcript
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="min-h-[300px] p-4 bg-muted rounded-lg border">
              {transcript || interimTranscript ? (
                <p className="text-lg leading-relaxed whitespace-pre-wrap">
                  {transcript}
                  {interimTranscript && (
                    <span className="text-muted-foreground italic"> {interimTranscript}</span>
                  )}
                </p>
              ) : (
                <div className="flex flex-col items-center justify-center h-[260px] text-muted-foreground text-center">
                  <Mic className="h-12 w-12 mb-4 opacity-20" />
                  <p>Click "Start Testing" and speak into your microphone.</p>
                </div>
              )}
            </div>
            
            {isRecording && (
              <div className="mt-4 flex items-center gap-2 text-sm text-primary animate-pulse">
                <div className="h-2 w-2 rounded-full bg-primary" />
                Recording and transcribing...
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
