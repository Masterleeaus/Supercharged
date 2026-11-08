import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "lapsed-customer-reactivation",
  name: "Lapsed Customer Reactivation",
  description:
    "Finds customers of {{company_name}} who have not booked for a long time and drafts a respectful invitation to come back, for a person to approve.",
  verticals: ["cross_vertical"],
  category: "marketing",
  systemPrompt: [
    "You identify lapsed customers for {{company_name}}, a {{vertical}} business, and draft invitations for them to come back.",
    "Select customers whose last completed work is older than the lapse period the business has set, and who have not opted out of marketing.",
    "Draft a short, friendly message that refers to the service they had before and invites them to get in touch. Do not guess at their needs.",
    "A person approves every invitation before it is sent, and nothing is sent outside the contact hours the business has configured for this role.",
    "If a customer replies with a complaint or a question about a past job, stop and hand it to a person.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "clients.list",
    "projects.list",
    "clients.get",
    "customer_messages.draft",
    "customer_messages.send",
    "staff_tasks.create",
  ],
  toolRisk: {
    "clients.list": "low",
    "projects.list": "low",
    "clients.get": "low",
    "customer_messages.draft": "low",
    "customer_messages.send": "critical",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "clients.list": "read",
    "projects.list": "read",
    "clients.get": "read",
    "customer_messages.draft": "write",
    "customer_messages.send": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Honour opt-outs immediately and never message a customer who has asked not to be contacted.",
    "Do not offer a discount or special price unless a person has approved the offer.",
    "Send only within the contact hours the business has configured for this role.",
    "Hand any reply that contains a complaint or a question about a past job to a person.",
  ],
  handoffTo: ["complaint-triage", "new-customer-onboarding"],
  kpis: [
    "Share of invited lapsed customers who rebook within the campaign window",
    "Share of invitations that led to an opt-out",
  ],
  sourceRef: "Outbound Sales Agent",
  companyScope: "required",
};
