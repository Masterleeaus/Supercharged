import { useTranslation } from "react-i18next";
import { CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { getLanguageLabel } from "@/lib/languages";
import { customVoiceEngineVoices, openaiVoices } from "./constants";
import type { UseCase, WizardFormData } from "./types";

interface ReviewStepProps {
  formData: WizardFormData;
  selectedUseCase: UseCase | undefined;
  hasAlternateEngines: boolean;
}

export function ReviewStep({ formData, selectedUseCase, hasAlternateEngines }: ReviewStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500/20 mb-4">
          <CheckCircle2 className="h-6 w-6 text-emerald-500" />
        </div>
        <h3 className="text-lg font-semibold">Review Your Agent</h3>
        <p className="text-sm text-muted-foreground">
          Everything looks good! Review and create your agent.
        </p>
      </div>

      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground">Use Case</Label>
                <p className="font-medium">{selectedUseCase?.title || "Custom"}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Name</Label>
                <p className="font-medium">{formData.name}</p>
              </div>
              {hasAlternateEngines && (
                <div>
                  <Label className="text-xs text-muted-foreground">Telephony Provider</Label>
                  <p className="font-medium">
                    {formData.telephonyProvider === "plivo" 
                      ? "OpenAI + Plivo" 
                      : formData.telephonyProvider === "twilio_openai"
                        ? "OpenAI + Twilio"
                        : formData.telephonyProvider === "custom-voice-engine"
                          ? "Custom Voice Engine"
                          : formData.telephonyProvider === "elevenlabs-sip"
                            ? "ElevenLabs SIP"
                            : formData.telephonyProvider === "openai-sip"
                              ? "OpenAI SIP"
                              : "ElevenLabs + Twilio"}
                  </p>
                </div>
              )}
              <div>
                <Label className="text-xs text-muted-foreground">Voice</Label>
                <p className="font-medium">
                  {formData.telephonyProvider === "custom-voice-engine"
                    ? (customVoiceEngineVoices.find(v => v.value === formData.openaiVoice)?.label || formData.openaiVoice)
                    : (formData.telephonyProvider === "plivo" || formData.telephonyProvider === "twilio_openai" || formData.telephonyProvider === "openai-sip")
                      ? (openaiVoices.find(v => v.value === formData.openaiVoice)?.label || formData.openaiVoice)
                      : (formData.elevenLabsVoiceId || "Not selected")
                  }
                </p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Language</Label>
                <p className="font-medium">{t(`agents.languages.${formData.language}`, { defaultValue: getLanguageLabel(formData.language) })}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Voice Tone</Label>
                <p className="font-medium capitalize">{formData.voiceTone}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Personality</Label>
                <p className="font-medium capitalize">{formData.personality}</p>
              </div>
              {formData.telephonyProvider === "twilio" && (
                <div>
                  <Label className="text-xs text-muted-foreground">Voice Speed</Label>
                  <p className="font-medium">{formData.voiceSpeed.toFixed(2)}x</p>
                </div>
              )}
            </div>

            <Separator className="my-4" />

            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">System Prompt</Label>
                <p className="text-sm mt-1 line-clamp-3">{formData.systemPrompt}</p>
              </div>
              {formData.firstMessage && (
                <div>
                  <Label className="text-xs text-muted-foreground">First Message</Label>
                  <p className="text-sm mt-1">{formData.firstMessage}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
