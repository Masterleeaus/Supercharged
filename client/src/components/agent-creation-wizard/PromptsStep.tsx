import { FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import PromptTemplatesLibrary from "@/components/PromptTemplatesLibrary";
import type { WizardFormData, WizardFormSetter } from "./types";

interface PromptsStepProps {
  formData: WizardFormData;
  setFormData: WizardFormSetter;
  templatesOpen: boolean;
  setTemplatesOpen: (open: boolean) => void;
}

export function PromptsStep({ formData, setFormData, templatesOpen, setTemplatesOpen }: PromptsStepProps) {
  const { toast } = useToast();
  return (
    <div className="space-y-6">
      <div className="text-center mb-4">
        <h3 className="text-lg font-semibold">Configure Prompts</h3>
        <p className="text-sm text-muted-foreground">
          Customize what your agent says and how it behaves
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTemplatesOpen(true)}
          data-testid="button-use-template"
        >
          <FileText className="h-4 w-4 mr-2" />
          Use Template
        </Button>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="systemPrompt">
            System Prompt <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="systemPrompt"
            value={formData.systemPrompt}
            onChange={(e) => setFormData(prev => ({ ...prev, systemPrompt: e.target.value }))}
            placeholder="Describe your agent's role, responsibilities, and behavior guidelines..."
            className="min-h-[150px] resize-none"
            data-testid="textarea-system-prompt"
          />
          <p className="text-xs text-muted-foreground">
            Use {"{{variable}}"} syntax for dynamic values like {"{{company_name}}"} or {"{{agent_name}}"}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="firstMessage">First Message</Label>
          <Textarea
            id="firstMessage"
            value={formData.firstMessage}
            onChange={(e) => setFormData(prev => ({ ...prev, firstMessage: e.target.value }))}
            placeholder="What your agent says when answering a call..."
            className="min-h-[80px] resize-none"
            data-testid="textarea-first-message"
          />
          <p className="text-xs text-muted-foreground">
            Best practices: Start warm and natural. Example: "Hi {'{{first_name}}'}, this is Sarah from ABC Corp, how's your day going?"
          </p>
          
          {/* Dynamic Variables Helper */}
          <div className="mt-2 p-3 bg-muted/50 rounded-md border border-muted">
            <p className="text-xs font-medium text-foreground mb-2">Available Dynamic Variables</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {['{{first_name}}', '{{last_name}}', '{{contact_name}}', '{{email}}', '{{phone}}', '{{city}}', '{{company}}'].map((variable) => (
                <Badge 
                  key={variable} 
                  variant="secondary" 
                  className="text-xs font-mono cursor-pointer hover-elevate"
                  onClick={() => {
                    setFormData(prev => ({ ...prev, firstMessage: prev.firstMessage + variable }));
                  }}
                  data-testid={`badge-wizard-variable-${variable.replace(/[{}]/g, '')}`}
                >
                  {variable}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Click to insert. Variables are replaced with contact data from your campaign CSV.</p>
          </div>
        </div>
      </div>

      <Dialog open={templatesOpen} onOpenChange={setTemplatesOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Prompt Templates</DialogTitle>
            <DialogDescription>
              Choose a template to use as a starting point
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <PromptTemplatesLibrary
              mode="select"
              onSelectTemplate={(template) => {
                setFormData(prev => ({
                  ...prev,
                  systemPrompt: template.systemPrompt,
                  firstMessage: template.firstMessage || prev.firstMessage,
                  voiceTone: template.suggestedVoiceTone || prev.voiceTone,
                  personality: template.suggestedPersonality || prev.personality,
                }));
                setTemplatesOpen(false);
                toast({
                  title: "Template Applied",
                  description: "Template has been applied to your agent.",
                });
              }}
            />
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
