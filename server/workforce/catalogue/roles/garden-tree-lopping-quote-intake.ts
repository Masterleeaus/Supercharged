import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "garden-tree-lopping-quote-intake",
  name: "Tree Lopping Quote Intake",
  description:
    "Captures tree lopping and removal enquiries for {{company_name}}, records the tree and site details, and flags anything near power lines or buildings for a qualified arborist.",
  verticals: ["garden"],
  category: "quotes",
  systemPrompt: [
    "You are the tree work intake assistant for {{company_name}}, a {{vertical}} business.",
    "Capture the tree type if known, its approximate height, the reason for the work, whether it stands on the customer's land or a neighbour's, and photos if the customer can send them.",
    "Ask whether the tree is near power lines, a house, a road, a fence or a pool. Any of these must be flagged before a quote is booked.",
    "Record the request as an estimate request for an on-site assessment. Do not give a price, a felling method or a removal plan.",
    "Never tell the customer to climb, cut or fell a tree themselves, and never suggest a cut to make a tree safer.",
    "If a tree has fallen onto a building, vehicle or power line, or someone is hurt, tell the customer to call emergency services now and hand the case to a person right away.",
  ].join("\n"),
  channels: ["voice", "sms", "email", "web"],
  autonomy: "auto",
  tools: [
    "clients.list",
    "clients.create",
    "property_issues.create",
    "estimates.create",
  ],
  toolRisk: {
    "clients.list": "low",
    "clients.create": "high",
    "property_issues.create": "medium",
    "estimates.create": "high",
  },
  toolAccess: {
    "clients.list": "read",
    "clients.create": "write",
    "property_issues.create": "write",
    "estimates.create": "write",
  },
  guardrails: [
    "Do not quote prices, removal times or crane and machinery needs.",
    "Do not give felling, pruning or cutting advice to the customer.",
    "Do not book a tree job near power lines until a person has flagged it.",
    "Tell callers about a fallen tree on a building, vehicle or person to contact emergency services first.",
  ],
  handoffTo: ["garden-after-hours-emergency-triage", "garden-quote-chaser"],
  kpis: [
    "Share of tree enquiries captured with height, location and hazard answers",
    "Tree enquiries flagged near power lines or buildings before booking",
    "Average hours from enquiry to assessment booked",
  ],
  sourceRef: "Lead Qualification Agent",
  companyScope: "required",
};
