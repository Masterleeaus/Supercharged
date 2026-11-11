import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Star, Clock, ArrowDownUp } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { Lead, LeadStage, getStageTheme } from "@/pages/crm/shared";
import { LeadCard } from "@/pages/crm/LeadCard";



export function KanbanColumn({ stage, leads, onLeadClick, onDrop, onSort, selectedLeadIds, onToggleSelect }: { 
  stage: LeadStage; 
  leads: Lead[]; 
  onLeadClick: (lead: Lead) => void;
  onDrop: (leadId: string, newStage: string, newStageId: string) => void;
  onSort: (stageId: string, sortBy: "score" | "date") => void;
  selectedLeadIds?: Set<string>;
  onToggleSelect?: (leadId: string) => void;
}) {
  const { t } = useTranslation();
  const theme = getStageTheme(stage.name, stage.color);
  const StageIcon = theme.icon;
  
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.add("ring-2", "ring-white/30");
  };
  
  const handleDragLeave = (e: React.DragEvent) => {
    e.currentTarget.classList.remove("ring-2", "ring-white/30");
  };
  
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove("ring-2", "ring-white/30");
    const leadId = e.dataTransfer.getData("leadId");
    if (leadId) {
      onDrop(leadId, stage.name, stage.id);
    }
  };

  return (
    <div 
      className="flex flex-col min-w-[300px] max-w-[300px] rounded-xl overflow-hidden transition-all border border-border/50 bg-card"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid={`kanban-column-${stage.id}`}
    >
      <div 
        className={`${theme.headerGradient} px-4 py-3 text-white`}
        style={theme.customColorStyle || undefined}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-white/20">
              <StageIcon className="w-4 h-4" />
            </div>
            <h3 className="font-semibold text-sm uppercase tracking-wide">
              {stage.name.replace(/_/g, " ")}
            </h3>
            <Badge className="h-5 px-1.5 text-[10px] font-medium bg-white/20 text-white border-0">
              {leads.length}
            </Badge>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20" data-testid={`column-menu-${stage.id}`}>
                <ArrowDownUp className="w-3.5 h-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onSort(stage.id, "score")} data-testid={`sort-score-${stage.id}`}>
                <Star className="w-4 h-4 mr-2" /> {t("crmPage.sortByScore")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSort(stage.id, "date")} data-testid={`sort-date-${stage.id}`}>
                <Clock className="w-4 h-4 mr-2" /> {t("crmPage.sortByDate")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      
      <ScrollArea className="flex-1 p-2" style={{ maxHeight: "calc(100vh - 260px)" }}>
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {leads.map((lead) => (
              <div
                key={lead.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("leadId", lead.id);
                }}
              >
                <LeadCard 
                  lead={lead} 
                  onClick={() => onLeadClick(lead)} 
                  stageColor={stage.color}
                  isSelected={selectedLeadIds?.has(lead.id)}
                  onToggleSelect={onToggleSelect}
                />
              </div>
            ))}
          </AnimatePresence>
          {leads.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center mb-2">
                <StageIcon className={`w-4 h-4 ${theme.accent}`} />
              </div>
              <p className="text-xs text-muted-foreground">{t("crmPage.noLeads")}</p>
              <p className="text-[10px] text-muted-foreground/60 mt-0.5">{t("crmPage.dropLeadsHere")}</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}