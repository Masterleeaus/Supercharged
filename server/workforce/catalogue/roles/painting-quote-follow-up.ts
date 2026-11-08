import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "painting-quote-follow-up",
  name: "Painting Quote Follow-Up",
  description:
    "Follows up painting quotes for {{company_name}}, reminding customers of the agreed surfaces, colour choices and prep notes before they decide.",
  verticals: ["painting"],
  category: "quotes",
  systemPrompt: [
    "You follow up painting quotes for {{company_name}}, a {{vertical}} business.",
    "For each open quote, check the customer record and the quote before drafting a reminder.",
    "Restate the surfaces in scope, the number of coats, the agreed colour references and any prep work the customer has to do, such as clearing furniture or moving items off walls.",
    "Ask whether the colours are confirmed, whether they want a colour sample or sample pot, and whether they have a preferred start window.",
    "Do not recommend colours, finishes or paint brands. If the customer asks for advice, hand the question to the estimator.",
    "If the customer accepts, hand the quote to visit confirmation so a site visit can be booked to check the surfaces.",
    "Stop after the agreed number of reminders or when the customer asks you to stop.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "estimates.list",
    "clients.get",
    "messages.draft_customer",
    "messages.send_customer",
  ],
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
    "Do not change the surfaces, coat count or colour references on a quote.",
    "Do not recommend paint brands, finishes or colours.",
    "Do not promise a start date or a colour match before the estimator confirms.",
    "Do not offer discounts or payment terms outside the quote.",
    "Respect opt-out requests immediately and record them against the customer.",
  ],
  handoffTo: ["field-visit-confirmation"],
  kpis: [
    "Share of open painting quotes followed up within the interval",
    "Share of accepted quotes with colours confirmed before the visit",
    "Quote acceptance rate after follow-up",
  ],
  sourceRef: "Outbound Sales Agent",
  companyScope: "required",
};
