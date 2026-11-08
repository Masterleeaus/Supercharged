/**
 * Voice Engine STT Test Component
 * Provides a real-time microphone test for the configured STT provider.
 */
import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Mic, MicOff, AlertCircle, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Transcript {
  text: string;
  isFinal: boolean;
  confidence: number;
}

export default function VoiceEngineSttTest() {
  const { toast } = useToast();
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<string>("");

  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  useEffect(() => {
    return () => {
      stopTesting();
    };
  }, []);

  const startTesting = async () => {
    setError(null);
    setTranscripts([]);
    setInterimTranscript("");

    try {
      // 1. Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 2. Connect to WebSocket
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/voice-engine/test/stt`;
      
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        setIsConnected(true);
        console.log("[STT Test] WebSocket connected");
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "ready") {
          setActiveProvider(data.provider);
          setupAudioProcessing(stream);
        } else if (data.type === "transcript") {
          if (data.isFinal) {
            setTranscripts((prev) => [...prev, { text: data.text, isFinal: true, confidence: data.confidence }]);
            setInterimTranscript("");
          } else {
            setInterimTranscript(data.text);
          }
        } else if (data.type === "error") {
          setError(data.message);
          stopTesting();
        }
      };

      socket.onerror = () => {
        setError("WebSocket connection failed. Ensure the server is running.");
        stopTesting();
      };

      socket.onclose = () => {
        setIsConnected(false);
        setIsRecording(false);
        console.log("[STT Test] WebSocket closed");
      };

      setIsRecording(true);
    } catch (err: any) {
      setError(err.message || "Failed to access microphone");
      toast({
        title: "Mic Error",
        description: "Could not access microphone. Please check permissions.",
        variant: "destructive",
      });
    }
  };

  const setupAudioProcessing = (stream: MediaStream) => {
    const audioContext = new AudioContext({ sampleRate: 16000 });
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    
    // ScriptProcessor is deprecated but widely supported for this kind of simple streaming
    // In a real app, AudioWorklet would be better
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Convert Float32 to Int16
        const l = inputData.length;
        const buf = new Int16Array(l);
        for (let i = 0; i < l; i++) {
          buf[i] = Math.min(1, inputData[i]) * 0x7fff;
        }
        
        socketRef.current.send(buf.buffer);
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  };

  const stopTesting = () => {
    setIsRecording(false);
    setIsConnected(false);

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

    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-indigo-100 dark:border-indigo-950">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Real-time STT Test</CardTitle>
              <CardDescription>
                Test your Speech-to-Text configuration directly from your browser.
              </CardDescription>
            </div>
            {isConnected && (
              <Badge variant="secondary" className="bg-emerald-50 text-emerald-600 border-emerald-200">
                <CheckCircle2 className="h-3 w-3 mr-1" /> {activeProvider} Ready
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4">
            {!isRecording ? (
              <Button onClick={startTesting} className="bg-indigo-600 hover:bg-indigo-700">
                <Mic className="h-4 w-4 mr-2" /> Start Live Test
              </Button>
            ) : (
              <Button onClick={stopTesting} variant="destructive">
                <MicOff className="h-4 w-4 mr-2" /> Stop Test
              </Button>
            )}
            {isRecording && !isConnected && (
              <div className="flex items-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting to STT engine...
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-600 text-sm border border-red-100">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          <div className="min-h-[200px] max-h-[400px] overflow-y-auto p-4 rounded-lg bg-muted/40 border font-sans text-sm space-y-3">
            {transcripts.length === 0 && !interimTranscript && !isRecording && (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-60 py-12">
                <Mic className="h-8 w-8 mb-2" />
                <p>Click "Start Live Test" and speak into your microphone.</p>
              </div>
            )}
            
            {transcripts.map((t, i) => (
              <div key={i} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
                <p className="text-foreground leading-relaxed">
                  {t.text}
                  <span className="ml-2 text-[10px] text-muted-foreground opacity-70">
                    ({Math.round(t.confidence * 100)}%)
                  </span>
                </p>
              </div>
            ))}
            
            {interimTranscript && (
              <div className="text-muted-foreground italic animate-pulse">
                {interimTranscript}...
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
