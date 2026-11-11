import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Star, MoreHorizontal, ArrowDownUp, Zap, GripVertical } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { Lead, AI_CATEGORIES, AICategory, COLOR_PRESETS } from "@/pages/crm/shared";
import { LeadCard } from "@/pages/crm/LeadCard";



export function AIKanbanColumn({ 
  category, 
  leads, 
  total,
  onLeadClick, 
  selectedLeadIds, 
  onToggleSelect,
  highlighted = false,
  sortBy,
  onSortChange,
  onColorChange,
  onLeadDrop,
  isDragging = false,
  isDragOver = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}: { 
  category: { id: AICategory; label: string; color: string };
  leads: Lead[]; 
  total: number;
  onLeadClick: (lead: Lead) => void;
  selectedLeadIds?: Set<string>;
  onToggleSelect?: (leadId: string) => void;
  highlighted?: boolean;
  sortBy?: 'newest' | 'oldest' | 'score-high' | 'score-low';
  onSortChange?: (sortBy: 'newest' | 'oldest' | 'score-high' | 'score-low') => void;
  onColorChange?: (color: string) => void;
  onLeadDrop?: (leadId: string, targetCategory: AICategory) => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const { t } = useTranslation();
  const categoryInfo = AI_CATEGORIES.find(c => c.id === category.id);
  const Icon = categoryInfo?.icon || Zap;

  return (
    <div 
      className={`flex flex-col min-w-[300px] max-w-[300px] rounded-xl overflow-hidden transition-all border bg-card ${
        highlighted ? 'border-primary ring-2 ring-primary/30 shadow-lg' : 'border-border/50 opacity-90'
      } ${isDragging ? 'opacity-50 scale-95' : ''} ${isDragOver ? 'ring-2 ring-blue-400 scale-[1.02]' : ''}`}
      data-testid={`ai-kanban-column-${category.id}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div 
        className="px-4 py-3 text-white cursor-grab active:cursor-grabbing"
        style={{ backgroundColor: category.color }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GripVertical className="w-4 h-4 text-white/60" />
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-white/20">
              <Icon className="w-4 h-4" />
            </div>
            <h3 className="font-semibold text-sm uppercase tracking-wide">
              {t(`crmPage.categories.${category.id}`, { defaultValue: category.label })}
            </h3>
            <Badge className="h-5 px-1.5 text-[10px] font-medium bg-white/20 text-white border-0">
              {total}
            </Badge>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem 
                onClick={() => onSortChange?.('newest')}
                className={sortBy === 'newest' ? 'bg-accent' : ''}
              >
                <ArrowDownUp className="w-4 h-4 mr-2" />
                {t("crmPage.sortNewest")}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => onSortChange?.('oldest')}
                className={sortBy === 'oldest' ? 'bg-accent' : ''}
              >
                <ArrowDownUp className="w-4 h-4 mr-2" />
                {t("crmPage.sortOldest")}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => onSortChange?.('score-high')}
                className={sortBy === 'score-high' ? 'bg-accent' : ''}
              >
                <Star className="w-4 h-4 mr-2" />
                {t("crmPage.sortScoreHigh")}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => onSortChange?.('score-low')}
                className={sortBy === 'score-low' ? 'bg-accent' : ''}
              >
                <Star className="w-4 h-4 mr-2" />
                {t("crmPage.sortScoreLow")}
              </DropdownMenuItem>
              <Separator className="my-1" />
              <div className="px-2 py-1.5">
                <p className="text-xs font-medium mb-2">{t("crmPage.columnColor")}</p>
                <div className="grid grid-cols-4 gap-1">
                  {COLOR_PRESETS.slice(0, 8).map((preset) => (
                    <button
                      key={preset.hex}
                      className={`w-6 h-6 rounded-md transition-transform hover:scale-110 ${
                        category.color.toLowerCase() === preset.hex.toLowerCase() ? 'ring-2 ring-primary ring-offset-1' : ''
                      }`}
                      style={{ backgroundColor: preset.hex }}
                      onClick={() => onColorChange?.(preset.hex)}
                      title={preset.name}
                    />
                  ))}
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      
      <ScrollArea 
        className="flex-1 p-2" 
        style={{ maxHeight: "calc(100vh - 260px)" }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const leadId = e.dataTransfer.getData("leadId");
          if (leadId && onLeadDrop) {
            onLeadDrop(leadId, category.id);
          }
        }}
      >
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {leads.map((lead) => (
              <div 
                key={lead.id}
                draggable
                onDragStart={(e) => {
                  e.stopPropagation();
                  e.dataTransfer.setData("leadId", lead.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
              >
                <LeadCard 
                  lead={lead} 
                  onClick={() => onLeadClick(lead)} 
                  stageColor={category.color}
                  isSelected={selectedLeadIds?.has(lead.id)}
                  onToggleSelect={onToggleSelect}
                />
              </div>
            ))}
          </AnimatePresence>
          {leads.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center min-h-[100px]">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center mb-2">
                <Icon className="w-4 h-4" style={{ color: category.color }} />
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