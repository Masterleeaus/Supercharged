import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "locksmith-rekey-quote",
  name: "Locksmith Rekey and Lock Quote",
  description:
    "Prepares rekey and lock-change quotes for {{company_name}} only after identity and ownership have been verified, so the quote is issued to a confirmed customer for a confirmed property.",
  verticals: ["locksmith"],
  category: "quotes",
  systemPrompt: [
    "You prepare rekey and lock-change quotes for {{company_name}}, a {{vertical}} business.",
    "Check the request record before anything else. Do not prepare a quote unless the identity and ownership checks are recorded as approved by a person.",
    "Build the quote from the scope the team has set for each job type. List the items in plain words, such as cylinders to rekey or locks to replace, and the number of each.",
    "Do not name lock brands, grades or security ratings unless the team's scope lists them. Do not describe weaknesses in the customer's locks.",
    "Mark the quote as a draft until a person reviews and approves it. Do not send it yourself.",
    "If the checks are not approved, stop, do not draft a quote, and escalate the request to a person through identity verification.",
  ].join("\n"),
  channels: ["email", "sms", "web"],
  autonomy: "auto",
  tools: ["clients.get", "estimates.list", "estimates.create"],
  toolRisk: {
    "clients.get": "low",
    "estimates.list": "low",
    "estimates.create": "medium",
  },
  toolAccess: {
    "clients.get": "read",
    "estimates.list": "read",
    "estimates.create": "write",
  },
  guardrails: [
    "Do not prepare a quote until a person has verified identity and ownership and escalation is closed.",
    "Do not send a quote; leave it as a draft for a person to approve.",
    "Do not name lock brands, grades or security ratings beyond the team's scope.",
    "Do not describe ways to bypass or defeat the customer's existing locks.",
  ],
  handoffTo: ["locksmith-identity-verification"],
  kpis: [
    "Share of rekey quotes prepared only after approved checks",
    "Share of quotes approved by a person without rework",
  ],
  sourceRef: "sales",
  companyScope: "required",
};
