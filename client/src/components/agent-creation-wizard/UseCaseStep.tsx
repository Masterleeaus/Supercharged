import { Check } from "lucide-react";
import { useCases } from "./constants";
import type { WizardFormData } from "./types";

const getColorClasses = (color: string, selected: boolean) => {
  const colors: Record<string, { bg: string; border: string; text: string; icon: string }> = {
    emerald: {
      bg: selected ? "bg-emerald-500/20 dark:bg-emerald-500/30" : "bg-muted/30 hover:bg-muted/50",
      border: selected ? "border-emerald-500/50" : "border-transparent hover:border-border",
      text: selected ? "text-emerald-700 dark:text-emerald-300" : "",
      icon: selected ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground",
    },
    blue: {
      bg: selected ? "bg-blue-500/20 dark:bg-blue-500/30" : "bg-muted/30 hover:bg-muted/50",
      border: selected ? "border-blue-500/50" : "border-transparent hover:border-border",
      text: selected ? "text-blue-700 dark:text-blue-300" : "",
      icon: selected ? "bg-blue-500/20 text-blue-600 dark:text-blue-400" : "bg-muted text-muted-foreground",
    },
    violet: {
      bg: selected ? "bg-violet-500/20 dark:bg-violet-500/30" : "bg-muted/30 hover:bg-muted/50",
      border: selected ? "border-violet-500/50" : "border-transparent hover:border-border",
      text: selected ? "text-violet-700 dark:text-violet-300" : "",
      icon: selected ? "bg-violet-500/20 text-violet-600 dark:text-violet-400" : "bg-muted text-muted-foreground",
    },
    amber: {
      bg: selected ? "bg-amber-500/20 dark:bg-amber-500/30" : "bg-muted/30 hover:bg-muted/50",
      border: selected ? "border-amber-500/50" : "border-transparent hover:border-border",
      text: selected ? "text-amber-700 dark:text-amber-300" : "",
      icon: selected ? "bg-amber-500/20 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground",
    },
    rose: {
      bg: selected ? "bg-rose-500/20 dark:bg-rose-500/30" : "bg-muted/30 hover:bg-muted/50",
      border: selected ? "border-rose-500/50" : "border-transparent hover:border-border",
      text: selected ? "text-rose-700 dark:text-rose-300" : "",
      icon: selected ? "bg-rose-500/20 text-rose-600 dark:text-rose-400" : "bg-muted text-muted-foreground",
    },
    slate: {
      bg: selected ? "bg-slate-500/20 dark:bg-slate-500/30" : "bg-muted/30 hover:bg-muted/50",
      border: selected ? "border-slate-500/50" : "border-transparent hover:border-border",
      text: selected ? "text-slate-700 dark:text-slate-300" : "",
      icon: selected ? "bg-slate-500/20 text-slate-600 dark:text-slate-400" : "bg-muted text-muted-foreground",
    },
  };
  return colors[color] || colors.slate;
};

interface UseCaseStepProps {
  formData: WizardFormData;
  handleUseCaseSelect: (useCaseId: string) => void;
}

export function UseCaseStep({ formData, handleUseCaseSelect }: UseCaseStepProps) {
  return (
    <div className="space-y-4">
      <div className="text-center mb-6">
        <h3 className="text-lg font-semibold">What will your AI agent do?</h3>
        <p className="text-sm text-muted-foreground">
          Choose a use case to get started with optimized settings
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {useCases.map((useCase) => {
          const selected = formData.useCase === useCase.id;
          const colors = getColorClasses(useCase.color, selected);
          return (
            <div
              key={useCase.id}
              className={`relative p-4 rounded-xl cursor-pointer transition-all duration-200 border-2 ${colors.bg} ${colors.border}`}
              onClick={() => handleUseCaseSelect(useCase.id)}
              data-testid={`usecase-${useCase.id}`}
            >
              <div className="flex items-start gap-3">
                <div className={`h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ${colors.icon}`}>
                  <useCase.icon className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className={`font-semibold ${colors.text}`}>{useCase.title}</h4>
                    {selected && <Check className="h-4 w-4 text-emerald-500" />}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {useCase.description}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
