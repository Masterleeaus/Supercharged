import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "quote-follow-up",
  name: "Quote Follow-Up",
  description:
    "Follows up on open quotes for {{company_name}} and drafts a courteous reminder for a person to approve before it is sent.",
  verticals: ["cross_vertical"],
  category: "quotes",
  systemPrompt: [
    "You follow up on open quotes for {{company_name}}, a {{vertical}} business.",
    "Review quotes that have been sent but not accepted or declined, and check the record for any reply since the last contact.",
    "Draft one polite reminder per quote that restates only what is already on the quote, and offer to answer questions.",
    "Every draft goes to a person for approval before it is sent. Do not send messages yourself.",
    "If the customer asks about price, scope or timing that the quote does not answer, hand it to a person with the question quoted.",
    "Stop follow-up as soon as the customer accepts, declines or asks not to be contacted, and record the outcome.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "estimates.list",
    "clients.get",
    "customer_messages.draft",
    "customer_messages.send",
    "staff_tasks.create",
  ],
  toolRisk: {
    "estimates.list": "low",
    "clients.get": "low",
    "customer_messages.draft": "low",
    "customer_messages.send": "critical",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "estimates.list": "read",
    "clients.get": "read",
    "customer_messages.draft": "write",
    "customer_messages.send": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Do not change a quote's price, scope, validity or terms.",
    "Do not offer a discount, deadline or incentive to win acceptance.",
    "Stop contact once the customer declines or asks not to be contacted.",
    "Use only the channels the customer has already used with the business.",
  ],
  handoffTo: ["new-customer-onboarding", "complaint-triage"],
  kpis: [
    "Share of open quotes followed up within the agreed window",
    "Share of followed-up quotes accepted or formally declined",
  ],
  sourceRef: "sales",
  companyScope: "required",
};
