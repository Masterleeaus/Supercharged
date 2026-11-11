import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Tag } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { motion } from "framer-motion";
import { Lead, getStageTheme, ScoreIndicator, SentimentIcon, ActivityIndicators } from "@/pages/crm/shared";



export function LeadCard({ lead, onClick, stageColor, isSelected, onToggleSelect }: { 
  lead: Lead; 
  onClick: () => void; 
  stageColor?: string;
  isSelected?: boolean;
  onToggleSelect?: (leadId: string) => void;
}) {
  const { t } = useTranslation();
  const hasValidPhone = lead.phone && lead.phone !== 'Unknown' && lead.phone.trim() !== '';
  const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(" ");
  // Primary display: Phone if valid, otherwise name, otherwise email, otherwise Unknown
  const primaryDisplay = hasValidPhone ? lead.phone : (fullName || lead.email || t("crmPage.unknownContact"));
  const theme = getStageTheme(lead.stage, stageColor);
  
  const description = lead.aiSummary || 
    (lead.transcript ? (typeof lead.transcript === 'string' ? lead.transcript : JSON.stringify(lead.transcript)).slice(0, 80) + "..." : null);

  const timeAgo = (() => {
    const activityDate = lead.lastCallAt || lead.updatedAt || lead.createdAt;
    if (!activityDate) return null;
    const diff = Date.now() - new Date(activityDate).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return t("crmPage.justNow");
    if (minutes < 60) return t("crmPage.minutesAgo", { count: minutes, defaultValue: "{{count}}m ago" });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("crmPage.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    return t("crmPage.daysAgo", { count: days });
  })();

  const borderStyle = stageColor && stageColor !== "#6B7280" 
    ? { borderLeftColor: stageColor } 
    : undefined;

  const hasNotes = (lead.notesCount ?? 0) > 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.15 }}
      className="group"
    >
      <Card 
        className={`cursor-pointer hover-elevate transition-all bg-card border-l-[3px] ${!borderStyle ? theme.accentBorder : ''} ${isSelected ? 'ring-2 ring-primary' : ''}`}
        onClick={onClick}
        data-testid={`lead-card-${lead.id}`}
        style={borderStyle}
      >
        <CardContent className="p-3">
          <div className="flex flex-col gap-2">
            {/* Header row: Checkbox, Score, Phone/Name, Notes icon */}
            <div className="flex items-center gap-2">
              {onToggleSelect && (
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => onToggleSelect(lead.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0"
                  data-testid={`select-lead-${lead.id}`}
                />
              )}
              
              {/* Lead Score */}
              <ScoreIndicator score={lead.leadScore} />
              
              {/* Phone Number / Name - Primary display */}
              <h4 className={`font-semibold text-sm text-foreground flex-1 truncate ${hasValidPhone ? 'font-mono' : ''}`} data-testid={`lead-primary-${lead.id}`}>
                {primaryDisplay}
              </h4>
              
              {/* Notes icon - show if notes exist */}
              {hasNotes && (
                <div 
                  className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-100 dark:bg-blue-900/50"
                  title={t("crmPage.notes")}
                >
                  <MessageSquare className="w-3.5 h-3.5 text-blue-500" />
                </div>
              )}
            </div>

            {/* Description - AI Summary */}
            {description && (
              <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                {description}
              </p>
            )}

            {/* Tags display */}
            {lead.tags && lead.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {lead.tags.slice(0, 3).map((tag, idx) => (
                  <Badge 
                    key={idx} 
                    variant="secondary" 
                    className="text-[10px] px-1.5 py-0 h-4 bg-primary/10 text-primary hover:bg-primary/20"
                  >
                    <Tag className="w-2.5 h-2.5 mr-0.5" />
                    {tag}
                  </Badge>
                ))}
                {lead.tags.length > 3 && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                    +{lead.tags.length - 3}
                  </Badge>
                )}
              </div>
            )}

            {/* Footer: Activity indicators and time */}
            <div className="flex items-center justify-between pt-1 border-t border-border/50">
              <div className="flex items-center gap-2">
                <ActivityIndicators lead={lead} />
                {lead.sentiment && <SentimentIcon sentiment={lead.sentiment} />}
              </div>
              {timeAgo && (
                <span className="text-[10px] text-muted-foreground">{timeAgo}</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}