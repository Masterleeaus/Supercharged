/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */

import { type Node, type Edge } from "@xyflow/react";

import { Play, MessageSquare, HelpCircle, GitBranch, Calendar, FileText, Webhook, Phone, Clock, StopCircle, Volume2, Mail, MessageCircle } from "lucide-react";

// Flow node data interface
export interface FlowNodeConfig {
  type?: string;
  message?: string;
  waitForResponse?: boolean;
  question?: string;
  variableName?: string;
  condition?: string;
  trueBranch?: string;
  falseBranch?: string;
  phoneNumber?: string;
  duration?: number;
  webhookUrl?: string;
  formId?: string;
  appointmentType?: string;
  endMessage?: string;
  // Play Audio node config
  audioUrl?: string;
  audioFileName?: string;
  interruptible?: boolean;
  waitForComplete?: boolean;
  // Google Sheets integration (appointment + form nodes)
  googleSheetId?: string;
  googleSheetName?: string;
  googleSheetTitle?: string;
  // Email node config
  templateName?: string;
  recipientEmail?: string;
  // WhatsApp node config
  templateBody?: string;
  language?: string;
  templateVariables?: Array<{ position: number; source: string; value: string }>;
  headerVariable?: { type: string; url?: string; value?: string; source?: string } | null;
  buttonVariables?: Array<{ index: number; label: string; url: string; value: string }>;
  templateComponents?: any[];
}

export interface FlowNodeData extends Record<string, unknown> {
  type: string;
  label: string;
  config?: FlowNodeConfig;
}

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge;

// Icon mapping
export const nodeTypeIcons = {
  message: MessageSquare,
  question: HelpCircle,
  condition: GitBranch,
  appointment: Calendar,
  form: FileText,
  webhook: Webhook,
  transfer: Phone,
  delay: Clock,
  end: StopCircle,
  play_audio: Volume2,
  send_email: Mail,
  send_whatsapp: MessageCircle,
};

// Colorful theme for each node type
export const nodeTypeColors = {
  message: {
    bg: "from-blue-500 to-blue-600 dark:from-blue-600 dark:to-blue-700",
    icon: "text-white",
    text: "text-white",
    handle: "#3b82f6",
  },
  question: {
    bg: "from-purple-500 to-purple-600 dark:from-purple-600 dark:to-purple-700",
    icon: "text-white",
    text: "text-white",
    handle: "#a855f7",
  },
  condition: {
    bg: "from-amber-500 to-amber-600 dark:from-amber-600 dark:to-amber-700",
    icon: "text-white",
    text: "text-white",
    handle: "#f59e0b",
  },
  appointment: {
    bg: "from-emerald-500 to-emerald-600 dark:from-emerald-600 dark:to-emerald-700",
    icon: "text-white",
    text: "text-white",
    handle: "#10b981",
  },
  form: {
    bg: "from-cyan-500 to-cyan-600 dark:from-cyan-600 dark:to-cyan-700",
    icon: "text-white",
    text: "text-white",
    handle: "#06b6d4",
  },
  webhook: {
    bg: "from-violet-500 to-violet-600 dark:from-violet-600 dark:to-violet-700",
    icon: "text-white",
    text: "text-white",
    handle: "#8b5cf6",
  },
  transfer: {
    bg: "from-pink-500 to-pink-600 dark:from-pink-600 dark:to-pink-700",
    icon: "text-white",
    text: "text-white",
    handle: "#ec4899",
  },
  delay: {
    bg: "from-orange-500 to-orange-600 dark:from-orange-600 dark:to-orange-700",
    icon: "text-white",
    text: "text-white",
    handle: "#f97316",
  },
  end: {
    bg: "from-red-500 to-red-600 dark:from-red-600 dark:to-red-700",
    icon: "text-white",
    text: "text-white",
    handle: "#ef4444",
  },
  play_audio: {
    bg: "from-brand to-brand/90 dark:from-brand dark:to-brand/90",
    icon: "text-white",
    text: "text-white",
    handle: "#06b6d4",
  },
  send_email: {
    bg: "from-indigo-500 to-indigo-600 dark:from-indigo-600 dark:to-indigo-700",
    icon: "text-white",
    text: "text-white",
    handle: "#6366f1",
  },
  send_whatsapp: {
    bg: "from-green-500 to-green-600 dark:from-green-600 dark:to-green-700",
    icon: "text-white",
    text: "text-white",
    handle: "#22c55e",
  },
};

export interface FlowFormSummary {
  id: string;
  name: string;
  description: string | null;
  fields?: Array<{ id: string; question: string; fieldType: string; isRequired: boolean; order: number }>;
}
