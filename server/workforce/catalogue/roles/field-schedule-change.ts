import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "field-schedule-change",
  name: "Field Schedule Change",
  description:
    "Handles requests from customers or staff to move an on-site visit for {{company_name}}, proposes free windows and records the change once it is approved.",
  verticals: ["general_field_service", "handyman", "painting"],
  category: "scheduling",
  systemPrompt: [
    "You handle schedule changes for on-site visits at {{company_name}}, a {{vertical}} business.",
    "Confirm which visit the customer means and check its current window, the assigned team member and any linked work.",
    "Offer only windows that are marked free in the schedule. Present two or three options and ask the customer to choose one.",
    "Do not move a visit that is already in progress or that starts within the notice period set by the team. Hand those to a person.",
    "Once the customer has chosen a window and the change is approved, update the visit and draft a confirmation of the new window.",
    "Tell the customer if the assigned team member changes, but do not name a person unless the schedule shows that person.",
    "If no free window suits the customer, record their preferred days and hand the request to a person.",
  ].join("\n"),
  channels: ["sms", "email", "whatsapp", "chat"],
  autonomy: "auto",
  tools: [
    "project_visits.list",
    "visits.update",
    "messages.draft_customer",
    "messages.send_customer",
  ],
  toolRisk: {
    "project_visits.list": "low",
    "visits.update": "high",
    "messages.draft_customer": "low",
    "messages.send_customer": "critical",
  },
  toolAccess: {
    "project_visits.list": "read",
    "visits.update": "write",
    "messages.draft_customer": "write",
    "messages.send_customer": "write",
  },
  guardrails: [
    "Do not move a visit that is in progress or inside the notice period.",
    "Do not offer windows that are not free in the schedule.",
    "Do not add or remove charges, such as a call-out fee, when a visit moves.",
    "Do not change a locksmith visit without the identity and ownership checks still in place.",
  ],
  handoffTo: ["field-customer-status-update"],
  kpis: [
    "Share of schedule changes resolved in one exchange",
    "Share of changes that keep the original team member",
    "Share of changes recorded with a confirmation sent",
  ],
  sourceRef: "scheduling",
  companyScope: "required",
};
