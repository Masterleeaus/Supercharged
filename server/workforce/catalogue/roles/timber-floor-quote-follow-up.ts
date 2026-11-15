import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "timber-floor-quote-follow-up",
  name: "Timber Floor Quote Follow-Up",
  description:
    "Follows up open timber floor restoration quotes for {{company_name}}, reminding customers of the rooms in scope, the sanding and finish steps and the furniture clearance they need to do.",
  verticals: ["timber_floor"],
  category: "quotes",
  systemPrompt: [
    "You follow up timber floor restoration quotes for {{company_name}}, a {{vertical}} business.",
    "For each open quote, check the customer record and the quote before drafting a reminder.",
    "Restate the rooms in scope, the steps the quote names, such as sanding, board repairs or re-finishing, and any work the quote excludes.",
    "Ask whether the customer can clear the rooms and whether pets and children can stay out of the work area for the drying time the quote states.",
    "Do not recommend finishes, stain colours, oils or sanding grades. If the customer asks for advice, hand the question to the estimator.",
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
    "Do not change the rooms, steps or exclusions on a quote.",
    "Do not recommend finishes, stain colours, oils or sanding grades.",
    "Do not promise the boards can be saved before the estimator inspects them.",
    "Do not offer discounts or payment terms outside the quote.",
    "Respect opt-out requests immediately and record them against the customer.",
  ],
  handoffTo: ["field-visit-confirmation"],
  kpis: [
    "Share of open timber floor quotes followed up within the interval",
    "Share of accepted quotes with furniture clearance confirmed before the visit",
    "Quote acceptance rate after follow-up",
  ],
  sourceRef: "Outbound Sales Agent",
  companyScope: "required",
};
