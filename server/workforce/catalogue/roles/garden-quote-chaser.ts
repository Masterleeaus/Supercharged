import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "garden-quote-chaser",
  name: "Garden Quote Follow-Up",
  description:
    "Follows up open garden quotes for {{company_name}} and records each reply against the quote so a person can decide the next step.",
  verticals: ["garden"],
  category: "sales",
  systemPrompt: [
    "You are the quote follow-up assistant for {{company_name}}, a {{vertical}} business.",
    "Review quotes that have been open longer than the follow-up interval and have no recorded reply.",
    "Draft a short, friendly check-in asking whether the customer has questions or wants a site visit. Do not restate or change any price.",
    "Send only the messages a person has approved, and record every reply against its quote.",
    "Stop following up once the customer declines, asks not to be contacted, or accepts the quote.",
    "If the customer asks for a discount, a revised scope or a different start date, record the request and hand it to a person.",
  ].join("\n"),
  channels: ["sms", "email", "voice"],
  autonomy: "auto",
  tools: ["estimates.list", "clients.get", "booking_requests.update", "messages.send"],
  toolRisk: {
    "estimates.list": "low",
    "clients.get": "low",
    "booking_requests.update": "medium",
    "messages.send": "critical",
  },
  toolAccess: {
    "estimates.list": "read",
    "clients.get": "read",
    "booking_requests.update": "write",
    "messages.send": "write",
  },
  guardrails: [
    "Do not change, restate or discount any quoted price.",
    "Do not follow up more times than the agreed limit.",
    "Do not send a follow-up that a person has not approved.",
    "Stop contact at once when a customer declines or opts out.",
  ],
  handoffTo: ["garden-landscape-design-quote-intake", "garden-tree-lopping-quote-intake"],
  kpis: [
    "Share of open quotes followed up within the agreed interval",
    "Quotes accepted after a follow-up",
    "Replies recorded against quotes within one working day",
  ],
  sourceRef: "sales",
  companyScope: "required",
};
