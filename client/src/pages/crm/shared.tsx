import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Users, Calendar, PhoneForwarded, TrendingUp, TrendingDown, Minus, Clock, Flame, UserX, PhoneMissed, ClipboardCheck, UserCheck, PhoneCall } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";




export interface Lead {
  id: string;
  userId: string;
  sourceType: string;
  campaignId: string | null;
  incomingConnectionId: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  email: string | null;
  stage: string;
  stageId: string | null;
  leadScore: number | null;
  aiSummary: string | null;
  aiCategory: string | null;
  sentiment: string | null;
  hasAppointment: boolean;
  hasFormSubmission: boolean;
  hasTransfer: boolean;
  hasCallback: boolean;
  transcript: string | null;
  recordingUrl: string | null;
  tags: string[] | null;
  notesCount?: number;
  createdAt: string;
  updatedAt: string;
  lastCallAt?: string | null;
}

export interface LeadNote {
  id: string;
  leadId: string;
  userId: string;
  content: string;
  createdAt: string;
}

export interface LeadActivity {
  id: string;
  leadId: string;
  userId: string;
  activityType: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface CRMAnalytics {
  totalLeads: number;
  leadsByStage: { stage: string; count: number }[];
  leadsByCategory: { category: string; count: number }[];
  leadsBySource: { sourceType: string; count: number }[];
  leadsByDate: { date: string; count: number }[];
  conversionRates: { fromStage: string; toStage: string; rate: number }[];
  avgLeadScore: number;
  sentimentBreakdown: { sentiment: string; count: number }[];
}

export interface LeadStage {
  id: string;
  name: string;
  color: string;
  order: number;
  isDefault: boolean;
  isCustom: boolean;
}

export interface Campaign {
  id: string;
  name: string;
}

export interface IncomingConnection {
  id: string;
  agentId: string;
  phoneNumberId: string;
}

// AI Lead Categories - only show qualified prospects
export const AI_CATEGORIES = [
  { id: 'appointment_booked', label: 'Appointment Booked', color: '#10B981', icon: Calendar },
  { id: 'form_submitted', label: 'Form Submitted', color: '#3B82F6', icon: ClipboardCheck },
  { id: 'call_transfer', label: 'Call Transfer', color: '#8B5CF6', icon: PhoneForwarded },
  { id: 'need_follow_up', label: 'Need Follow Up', color: '#F97316', icon: Clock },
  { id: 'hot', label: 'Hot Lead', color: '#EF4444', icon: Flame },
  { id: 'warm', label: 'Warm Lead', color: '#F59E0B', icon: TrendingUp },
] as const;

export type AICategory = typeof AI_CATEGORIES[number]['id'];

export interface CategoryCounts {
  counts: Record<AICategory, number>;
  total: number;
  categories: Array<{ id: AICategory; label: string; color: string; count: number }>;
}

export interface PaginatedLeadsResponse {
  leads: Lead[];
  total: number;
  hasMore: boolean;
}

export interface AIKanbanResponse {
  categories: Array<{ id: AICategory; label: string; color: string; total: number }>;
  columns: Record<AICategory, { leads: Lead[]; total: number; hasMore: boolean }>;
}

export interface CrmCategoryPreferences {
  id: string;
  userId: string;
  columnOrder: string[];
  colorOverrides: Record<string, string>;
  columnSortPreferences: Record<string, 'newest' | 'oldest' | 'score-high' | 'score-low'>;
  hideLeadsWithoutPhone: boolean;
  categoryPipelineMappings: Record<string, string>;
  hotScoreThreshold: number;
  warmScoreThreshold: number;
  hiddenCategories: string[];
}

export const COLOR_PRESETS = [
  { name: "Emerald", hex: "#10B981", gradient: "from-emerald-500 to-emerald-600" },
  { name: "Orange", hex: "#F97316", gradient: "from-orange-500 to-red-500" },
  { name: "Blue", hex: "#3B82F6", gradient: "from-blue-500 to-blue-600" },
  { name: "Purple", hex: "#8B5CF6", gradient: "from-purple-500 to-purple-600" },
  { name: "Amber", hex: "#F59E0B", gradient: "from-amber-500 to-amber-600" },
  { name: "Rose", hex: "#F43F5E", gradient: "from-rose-500 to-rose-600" },
  { name: "Slate", hex: "#64748B", gradient: "from-slate-500 to-slate-600" },
  { name: "Teal", hex: "#14B8A6", gradient: "from-brand to-brand/90" },
  { name: "Indigo", hex: "#6366F1", gradient: "from-indigo-500 to-indigo-600" },
  { name: "Pink", hex: "#EC4899", gradient: "from-pink-500 to-pink-600" },
  { name: "Cyan", hex: "#06B6D4", gradient: "from-cyan-500 to-cyan-600" },
  { name: "Lime", hex: "#84CC16", gradient: "from-lime-500 to-lime-600" },
];

export const stageThemes: Record<string, { 
  accent: string;
  accentBorder: string;
  headerGradient: string;
  icon: typeof Flame;
  badgeBg: string;
}> = {
  "new": { 
    accent: "text-emerald-600 dark:text-emerald-400",
    accentBorder: "border-l-emerald-500",
    headerGradient: "bg-gradient-to-r from-emerald-500 to-emerald-600",
    icon: UserCheck,
    badgeBg: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
  },
  "hot": { 
    accent: "text-orange-600 dark:text-orange-400",
    accentBorder: "border-l-orange-500",
    headerGradient: "bg-gradient-to-r from-orange-500 to-red-500",
    icon: Flame,
    badgeBg: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
  },
  "appointment": { 
    accent: "text-blue-600 dark:text-blue-400",
    accentBorder: "border-l-blue-500",
    headerGradient: "bg-gradient-to-r from-blue-500 to-blue-600",
    icon: Calendar,
    badgeBg: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
  },
  "form_submitted": { 
    accent: "text-purple-600 dark:text-purple-400",
    accentBorder: "border-l-purple-500",
    headerGradient: "bg-gradient-to-r from-purple-500 to-purple-600",
    icon: ClipboardCheck,
    badgeBg: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
  },
  "follow_up": { 
    accent: "text-amber-600 dark:text-amber-400",
    accentBorder: "border-l-amber-500",
    headerGradient: "bg-gradient-to-r from-amber-500 to-amber-600",
    icon: Clock,
    badgeBg: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
  },
  "not_interested": { 
    accent: "text-rose-600 dark:text-rose-400",
    accentBorder: "border-l-rose-500",
    headerGradient: "bg-gradient-to-r from-rose-500 to-rose-600",
    icon: UserX,
    badgeBg: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
  },
  "no_answer": { 
    accent: "text-slate-600 dark:text-slate-400",
    accentBorder: "border-l-slate-400",
    headerGradient: "bg-gradient-to-r from-slate-500 to-slate-600",
    icon: PhoneMissed,
    badgeBg: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
  },
};

export function hexToGradientStyle(hexColor: string): React.CSSProperties | null {
  const preset = COLOR_PRESETS.find(p => p.hex.toLowerCase() === hexColor.toLowerCase());
  if (preset) {
    return null;
  }
  const darkerHex = adjustColorBrightness(hexColor, -20);
  return {
    background: `linear-gradient(to right, ${hexColor}, ${darkerHex})`,
  };
}

export function adjustColorBrightness(hex: string, percent: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000FF) + percent));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function getStageTheme(stageName: string, customColor?: string) {
  const key = stageName.toLowerCase().replace(/\s+/g, "_");
  const baseTheme = stageThemes[key] || {
    accent: "text-slate-600 dark:text-slate-400",
    accentBorder: "border-l-slate-400",
    headerGradient: "bg-gradient-to-r from-slate-500 to-slate-600",
    icon: Users,
    badgeBg: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
  };
  
  if (customColor && customColor !== "#6B7280") {
    const preset = COLOR_PRESETS.find(p => p.hex.toLowerCase() === customColor.toLowerCase());
    if (preset) {
      return {
        ...baseTheme,
        headerGradient: `bg-gradient-to-r ${preset.gradient}`,
        customColorStyle: null,
      };
    }
    return {
      ...baseTheme,
      headerGradient: "",
      customColorStyle: hexToGradientStyle(customColor),
    };
  }
  
  return { ...baseTheme, customColorStyle: null };
}

export function ScoreIndicator({ score }: { score: number | null }) {
  const { t } = useTranslation();
  if (score === null || score === undefined) {
    return (
      <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
        <span className="text-xs font-medium text-muted-foreground">--</span>
      </div>
    );
  }

  const getScoreColor = (s: number) => {
    if (s >= 80) return { ring: "stroke-emerald-500", bg: "bg-emerald-50 dark:bg-emerald-950/50", text: "text-emerald-700 dark:text-emerald-400" };
    if (s >= 60) return { ring: "stroke-amber-500", bg: "bg-amber-50 dark:bg-amber-950/50", text: "text-amber-700 dark:text-amber-400" };
    if (s >= 40) return { ring: "stroke-blue-500", bg: "bg-blue-50 dark:bg-blue-950/50", text: "text-blue-700 dark:text-blue-400" };
    return { ring: "stroke-slate-400", bg: "bg-slate-100 dark:bg-slate-800", text: "text-slate-600 dark:text-slate-400" };
  };

  const colors = getScoreColor(score);
  const circumference = 2 * Math.PI * 16;
  const strokeDashoffset = circumference - (score / 100) * circumference;

  return (
    <div className={`relative flex items-center justify-center w-10 h-10 rounded-full ${colors.bg}`}>
      <svg className="w-10 h-10 -rotate-90" viewBox="0 0 40 40">
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className="text-muted/30"
        />
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={colors.ring}
        />
      </svg>
      <span className={`absolute text-xs font-bold ${colors.text}`}>{score}</span>
    </div>
  );
}

export function SentimentIcon({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  if (sentiment === "positive") return <TrendingUp className="w-4 h-4 text-emerald-500" />;
  if (sentiment === "negative") return <TrendingDown className="w-4 h-4 text-rose-500" />;
  return <Minus className="w-4 h-4 text-muted-foreground" />;
}

export function ActivityIndicators({ lead }: { lead: Lead }) {
  const { t } = useTranslation();
  const activities = [];
  
  if (lead.hasAppointment) {
    activities.push({ icon: Calendar, color: "text-blue-500", bg: "bg-blue-100 dark:bg-blue-900/50", label: t("crmPage.appointmentBooked") });
  }
  if (lead.hasFormSubmission) {
    activities.push({ icon: ClipboardCheck, color: "text-purple-500", bg: "bg-purple-100 dark:bg-purple-900/50", label: t("crmPage.formSubmitted") });
  }
  if (lead.hasTransfer) {
    activities.push({ icon: PhoneForwarded, color: "text-violet-500", bg: "bg-violet-100 dark:bg-violet-900/50", label: t("crmPage.transferred") });
  }
  if (lead.hasCallback) {
    activities.push({ icon: PhoneCall, color: "text-amber-500", bg: "bg-amber-100 dark:bg-amber-900/50", label: t("crmPage.callbackScheduled") });
  }

  if (activities.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      {activities.map((activity, index) => (
        <div 
          key={index} 
          className={`flex items-center justify-center w-6 h-6 rounded-md ${activity.bg}`}
          title={activity.label}
        >
          <activity.icon className={`w-3.5 h-3.5 ${activity.color}`} />
        </div>
      ))}
    </div>
  );
}

export function ListViewCard({ lead, onClick, stageColor, isSelected, onToggleSelect }: { 
  lead: Lead; 
  onClick: () => void; 
  stageColor?: string;
  isSelected?: boolean;
  onToggleSelect?: (leadId: string) => void;
}) {
  const { t } = useTranslation();
  // Show name if available, otherwise show phone number as the display name
  const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(" ");
  const hasValidPhone = lead.phone && lead.phone !== 'Unknown';
  const displayName = fullName || (hasValidPhone ? lead.phone : t("crmPage.unknownContact"));
  const initials = fullName 
    ? fullName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() 
    : (hasValidPhone ? lead.phone!.slice(-2) : "??");
  const theme = getStageTheme(lead.stage, stageColor);
  
  const borderStyle = stageColor && stageColor !== "#6B7280" 
    ? { borderLeftColor: stageColor } 
    : undefined;

  return (
    <Card 
      className={`cursor-pointer hover-elevate transition-all border-l-[3px] ${!borderStyle ? theme.accentBorder : ''} ${isSelected ? 'ring-2 ring-primary' : ''}`}
      style={borderStyle}
      onClick={onClick}
      data-testid={`list-lead-${lead.id}`}
    >
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          {onToggleSelect && (
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect(lead.id)}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0"
              data-testid={`select-list-lead-${lead.id}`}
            />
          )}
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarFallback className="text-xs font-medium bg-muted">
              {initials}
            </AvatarFallback>
          </Avatar>
          
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-sm truncate">{displayName}</h4>
            {/* Only show phone separately if we have a name (otherwise phone is already the display name) */}
            {fullName && hasValidPhone && (
              <p className="text-xs text-muted-foreground font-mono">{lead.phone}</p>
            )}
          </div>

          <ScoreIndicator score={lead.leadScore} />

          <ActivityIndicators lead={lead} />

          <Badge className={theme.badgeBg} variant="secondary">
            {lead.stage.replace(/_/g, " ")}
          </Badge>
          
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {new Date(lead.createdAt).toLocaleDateString()}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}