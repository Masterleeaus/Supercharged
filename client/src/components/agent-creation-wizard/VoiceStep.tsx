import { Volume2, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import VoicePreviewButton from "@/components/VoicePreviewButton";
import { customVoiceEngineVoices, openaiVoices } from "./constants";
import type { WizardFormData, WizardFormSetter } from "./types";

interface VoiceStepProps {
  formData: WizardFormData;
  setFormData: WizardFormSetter;
  isV3TtsModel: boolean;
}

export function VoiceStep({ formData, setFormData, isV3TtsModel }: VoiceStepProps) {
  return (
    <div className="space-y-6">
      <div className="text-center mb-6">
        <h3 className="text-lg font-semibold">Fine-tune Voice</h3>
        <p className="text-sm text-muted-foreground">
          {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai")
            ? "OpenAI voice settings are optimized automatically"
            : "Adjust voice characteristics for the perfect sound"
          }
        </p>
      </div>

      {(formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "custom-voice-engine") ? (
        // OpenAI or CVE engine - show simplified voice info
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <Volume2 className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <Label className="text-sm text-muted-foreground">Selected Voice</Label>
                  <p className="font-semibold text-lg">
                    {formData.telephonyProvider === "custom-voice-engine"
                      ? (customVoiceEngineVoices.find(v => v.value === formData.openaiVoice)?.label || formData.openaiVoice || "Asteria (Deepgram)")
                      : (openaiVoices.find(v => v.value === formData.openaiVoice)?.label || formData.openaiVoice)
                    }
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formData.telephonyProvider === "custom-voice-engine"
                      ? (customVoiceEngineVoices.find(v => v.value === formData.openaiVoice)?.description || "Deepgram Nova-2 voice")
                      : (openaiVoices.find(v => v.value === formData.openaiVoice)?.description)
                    }
                  </p>
                </div>
              </div>
              <div className="mt-4 p-3 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground">
                  {formData.telephonyProvider === "custom-voice-engine"
                    ? "Custom Voice Engine uses deepgram/sarvam voices optimized for low-latency streaming and high accuracy."
                    : "OpenAI Realtime voices are automatically optimized for natural conversation flow with low latency."
                  }
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        // ElevenLabs Twilio - show full voice settings
        <div className="space-y-6">
          {isV3TtsModel ? (
            <div className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg" data-testid="info-v3-voice-settings">
              <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <p className="text-xs text-muted-foreground">
                V3 Conversational model automatically optimizes voice quality. Use Expressive Mode and audio tags below to control how the agent sounds.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">Stability</Label>
                    <p className="text-xs text-muted-foreground">Higher = more consistent, Lower = more expressive</p>
                  </div>
                  <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                    {Math.round(formData.voiceStability * 100)}%
                  </span>
                </div>
                <Slider
                  value={[formData.voiceStability]}
                  onValueChange={([value]) => setFormData(prev => ({ ...prev, voiceStability: value }))}
                  min={0}
                  max={1}
                  step={0.01}
                  className="w-full"
                  data-testid="slider-stability"
                />
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">Similarity</Label>
                    <p className="text-xs text-muted-foreground">How closely to match the original voice</p>
                  </div>
                  <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                    {Math.round(formData.voiceSimilarityBoost * 100)}%
                  </span>
                </div>
                <Slider
                  value={[formData.voiceSimilarityBoost]}
                  onValueChange={([value]) => setFormData(prev => ({ ...prev, voiceSimilarityBoost: value }))}
                  min={0}
                  max={1}
                  step={0.01}
                  className="w-full"
                  data-testid="slider-similarity"
                />
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">Speed</Label>
                    <p className="text-xs text-muted-foreground">Speaking rate (0.7x to 1.2x)</p>
                  </div>
                  <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                    {formData.voiceSpeed.toFixed(2)}x
                  </span>
                </div>
                <Slider
                  value={[formData.voiceSpeed]}
                  onValueChange={([value]) => setFormData(prev => ({ ...prev, voiceSpeed: value }))}
                  min={0.7}
                  max={1.2}
                  step={0.05}
                  className="w-full"
                  data-testid="slider-speed"
                />
              </div>
            </>
          )}

          <div>
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <div>
                <Label className="text-sm font-medium">Response Delay</Label>
                <p className="text-xs text-muted-foreground">How long the agent waits before responding (0.5s to 5.0s)</p>
              </div>
              <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                {formData.turnTimeout.toFixed(1)}s
              </span>
            </div>
            <Slider
              value={[formData.turnTimeout]}
              onValueChange={([value]) => setFormData(prev => ({ ...prev, turnTimeout: value }))}
              min={0.5}
              max={5.0}
              step={0.1}
              className="w-full"
              data-testid="slider-turn-timeout"
            />
          </div>

          <div className="flex justify-center pt-4">
            <VoicePreviewButton
              voiceId={formData.elevenLabsVoiceId}
              voiceSettings={{
                stability: formData.voiceStability,
                similarity_boost: formData.voiceSimilarityBoost,
                speed: formData.voiceSpeed,
              }}
              previewText={formData.firstMessage || undefined}
              language={formData.language || undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}
