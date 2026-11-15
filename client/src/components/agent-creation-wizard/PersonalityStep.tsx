import { Check } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { personalityOptions, voiceToneOptions } from "./constants";
import type { WizardFormData, WizardFormSetter } from "./types";

interface PersonalityStepProps {
  formData: WizardFormData;
  setFormData: WizardFormSetter;
}

export function PersonalityStep({ formData, setFormData }: PersonalityStepProps) {
  return (
    <div className="space-y-6">
      <div className="text-center mb-6">
        <h3 className="text-lg font-semibold">Personality & Tone</h3>
        <p className="text-sm text-muted-foreground">
          Define how your agent sounds and behaves
        </p>
      </div>

      <div className="space-y-6">
        <div className="space-y-3">
          <Label className="text-sm font-medium">Voice Tone</Label>
          <div className="grid grid-cols-1 gap-2">
            {voiceToneOptions.map((option) => (
              <div
                key={option.value}
                className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                  formData.voiceTone === option.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-muted/50"
                }`}
                onClick={() => setFormData(prev => ({ ...prev, voiceTone: option.value }))}
                data-testid={`tone-${option.value}`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{option.label}</span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {option.description}
                    </span>
                  </div>
                  {formData.voiceTone === option.value && (
                    <Check className="h-4 w-4 text-primary" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <Label className="text-sm font-medium">Personality</Label>
          <div className="grid grid-cols-2 gap-2">
            {personalityOptions.map((option) => (
              <div
                key={option.value}
                className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                  formData.personality === option.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-muted/50"
                }`}
                onClick={() => setFormData(prev => ({ ...prev, personality: option.value }))}
                data-testid={`personality-${option.value}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{option.label}</span>
                  {formData.personality === option.value && (
                    <Check className="h-3 w-3 text-primary" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {option.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
