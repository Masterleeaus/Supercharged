import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Palette, Check } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { LeadStage, COLOR_PRESETS } from "@/pages/crm/shared";

export interface ColorSettingsDialogProps {
  colorSettingsOpen: boolean;
  setColorSettingsOpen: Dispatch<SetStateAction<boolean>>;
  sortedStages: LeadStage[];
  updateStageColorMutation: UseMutationResult<Response, any, { stageId: string; color: string; }, unknown>;
}

export function ColorSettingsDialog({ colorSettingsOpen, setColorSettingsOpen, sortedStages, updateStageColorMutation }: ColorSettingsDialogProps) {
  return (
    <Dialog open={colorSettingsOpen} onOpenChange={setColorSettingsOpen}>
        <DialogContent className="max-w-md" data-testid="color-settings-modal">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Palette className="w-5 h-5" />
              Pipeline Stage Colors
            </DialogTitle>
            <DialogDescription>
              Choose a color for each stage. The color will be used for the column header gradient.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {sortedStages.map((stage) => (
              <div key={stage.id} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-1">
                  <div 
                    className="w-4 h-4 rounded-full border"
                    style={{ backgroundColor: stage.color }}
                  />
                  <span className="text-sm font-medium">{stage.name.replace(/_/g, " ")}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1 max-w-[200px] justify-end">
                  {COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset.hex}
                      className={`w-6 h-6 rounded-full border-2 transition-all flex items-center justify-center ${
                        stage.color.toLowerCase() === preset.hex.toLowerCase() 
                          ? "border-foreground scale-110" 
                          : "border-transparent hover:scale-105"
                      }`}
                      style={{ backgroundColor: preset.hex }}
                      onClick={() => updateStageColorMutation.mutate({ stageId: stage.id, color: preset.hex })}
                      title={preset.name}
                      data-testid={`color-${stage.id}-${preset.name.toLowerCase()}`}
                    >
                      {stage.color.toLowerCase() === preset.hex.toLowerCase() && (
                        <Check className="w-3 h-3 text-white" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setColorSettingsOpen(false)} data-testid="close-color-settings">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
