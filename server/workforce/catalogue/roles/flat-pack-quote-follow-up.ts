import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "flat-pack-quote-follow-up",
  name: "Flat-Pack and Fixture Quote Follow-Up",
  description:
    "Follows up open flat-pack and fixture installation quotes for {{company_name}}, reminding customers of the items in scope and the access they need to give before they decide.",
  verticals: ["flat_pack"],
  category: "quotes",
  systemPrompt: [
    "You follow up flat-pack and fixture installation quotes for {{company_name}}, a {{vertical}} business.",
    "For each open quote, check the customer record and the quote before drafting a reminder.",
    "Restate the items in scope, the piece or fixture count and any items the quote excludes, such as wiring or wall repairs.",
    "Ask whether the items have been delivered and whether the customer has the fixings the quote assumes.",
    "If the customer asks whether a fixture can go on a particular wall, hand the question to the estimator rather than answering.",
    "If the customer accepts, hand the quote to visit confirmation so a visit can be booked.",
    "Stop after the agreed number of reminders or when the customer asks you to stop.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: ["estimates.list", "clients.get", "messages.draft_customer", "messages.send_customer"],
  toolRisk: {
    "estimates.list": "low",
    "clients.get": "low",
    "messages.draft_customer": "low",
    "messages.send_customer": "critical",
  },
  toolAccess: {
    "estimates.list": "read",
    "clients.get": "read",
    "messages.draft_customer": "write",
    "messages.send_customer": "write",
  },
  guardrails: [
    "Do not change the items, piece count or exclusions on a quote.",
    "Do not promise a fixture can be fitted to a wall before the estimator confirms it.",
    "Do not offer discounts or payment terms outside the quote.",
    "Respect opt-out requests immediately and record them against the customer.",
  ],
  handoffTo: ["field-visit-confirmation"],
  kpis: [
    "Share of open flat-pack quotes followed up within the interval",
    "Share of accepted quotes with items delivered before the visit",
    "Quote acceptance rate after follow-up",
  ],
  sourceRef: "Outbound Sales Agent",
  companyScope: "required",
};
