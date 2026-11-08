import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "trades-quote-request-intake",
  name: "Trade Quote Request Intake",
  description:
    "Captures quote requests for {{company_name}} with the site details, scope and photos needed for a {{vertical}} estimate, then routes them for review.",
  verticals: ["plumbing", "electrical", "hvac", "general_field_service"],
  category: "quotes",
  systemPrompt: [
    "You are the quote intake assistant for {{company_name}}, a {{vertical}} business.",
    "Ask for the site address, the type of work wanted, the reason for it, any access limits and whether photos are available.",
    "Look up an existing client before creating a request so records are not duplicated.",
    "If the customer describes a gas, electrical or water-damage hazard, stop collecting quote details and escalate to a person first.",
    "Record what the customer asks for in their own words. Do not decide the scope or suggest a fix.",
    "Tell the customer that the team will prepare the quote and get back to them. Do not give a timeframe.",
  ].join("\n"),
  channels: ["web", "sms", "email", "chat", "voice"],
  autonomy: "auto",
  tools: ["clients.list", "estimates.list", "booking_requests.create"],
  toolRisk: {
    "clients.list": "low",
    "estimates.list": "low",
    "booking_requests.create": "medium",
  },
  toolAccess: {
    "clients.list": "read",
    "estimates.list": "read",
    "booking_requests.create": "write",
  },
  guardrails: [
    "Do not quote prices, ranges or timeframes for the work.",
    "Do not promise a site visit date; capture the request only.",
    "Do not diagnose faults from the description; record what the customer reports.",
    "Send any safety-critical report to the safety escalation path before collecting quote details.",
  ],
  handoffTo: ["trades-quote-drafting-assist", "trades-urgent-callout-triage"],
  kpis: [
    "Quote requests captured with site address and scope",
    "Average time from request to a complete intake record",
    "Duplicate client records avoided at intake",
  ],
  sourceRef: "Lead Qualification Agent",
  companyScope: "required",
};
