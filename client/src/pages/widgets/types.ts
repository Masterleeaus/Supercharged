export const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern Time (ET)" },
  { value: "America/Chicago", label: "Central Time (CT)" },
  { value: "America/Denver", label: "Mountain Time (MT)" },
  { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
  { value: "Europe/London", label: "London (GMT)" },
  { value: "Europe/Paris", label: "Paris (CET)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Asia/Shanghai", label: "Shanghai (CST)" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Australia/Sydney", label: "Sydney (AEDT)" },
];

export const DAY_OPTIONS = [
  { value: "monday", label: "Mon" },
  { value: "tuesday", label: "Tue" },
  { value: "wednesday", label: "Wed" },
  { value: "thursday", label: "Thu" },
  { value: "friday", label: "Fri" },
  { value: "saturday", label: "Sat" },
  { value: "sunday", label: "Sun" },
];

export const COLOR_PRESETS = [
  { name: "Blue", primary: "#3B82F6" },
  { name: "Purple", primary: "#8B5CF6" },
  { name: "Green", primary: "#10B981" },
  { name: "Red", primary: "#EF4444" },
  { name: "Orange", primary: "#F97316" },
  { name: "Pink", primary: "#EC4899" },
  { name: "Teal", primary: "#14B8A6" },
  { name: "Indigo", primary: "#6366F1" },
];

export interface WidgetFormData {
  name: string;
  status: string;
  agentId: string | null;
  agentType: string;
  brandName: string;
  buttonLabel: string;
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  iconFile: File | null;
  iconPreview: string | null;
  requireTermsAcceptance: boolean;
  appointmentBookingEnabled: boolean;
  allowedDomains: string[];
  businessHoursEnabled: boolean;
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: string[];
  businessTimezone: string;
  maxConcurrentCalls: number;
  maxCallDuration: number;
  cooldownMinutes: number;
}

export const defaultFormData: WidgetFormData = {
  name: "",
  status: "active",
  agentId: null,
  agentType: "natural",
  brandName: "",
  buttonLabel: "VOICE CHAT",
  primaryColor: "#3B82F6",
  backgroundColor: "#FFFFFF",
  textColor: "#1F2937",
  iconFile: null,
  iconPreview: null,
  requireTermsAcceptance: false,
  appointmentBookingEnabled: false,
  allowedDomains: [],
  businessHoursEnabled: false,
  businessHoursStart: "09:00",
  businessHoursEnd: "17:00",
  businessDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  businessTimezone: "America/New_York",
  maxConcurrentCalls: 5,
  maxCallDuration: 300,
  cooldownMinutes: 0,
};

export interface WidgetStats {
  totalWidgets: number;
  totalCalls: number;
  totalMinutes: number;
  widgetStats: Array<{ id: string; name: string; calls: number; minutes: number; status: string }>;
}

export interface WidgetLimits {
  currentCount: number;
  maxWidgets: number;
  remaining: number;
}

export type CallState = 'idle' | 'terms' | 'connecting' | 'active' | 'ended';

