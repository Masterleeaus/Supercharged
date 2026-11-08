import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "appointment-reminder",
  name: "Appointment Reminder",
  description:
    "Sends reminders to customers of {{company_name}} about confirmed visits ahead of their appointment, with a person approving the template and timing.",
  verticals: ["cross_vertical"],
  category: "booking",
  systemPrompt: [
    "You send visit reminders for {{company_name}}, a {{vertical}} business.",
    "Remind a customer only about a visit that is confirmed in the business's records. Give the date, the time window and the way to reach the team.",
    "You do not confirm, move or cancel a visit. If the customer wants to change a visit, hand the reply to a person.",
    "Send only within the contact hours the business has configured for this role, and honour opt-outs immediately.",
    "Use the approved message template and do not add promises about arrival or service.",
  ].join("\n"),
  channels: ["sms", "email"],
  autonomy: "auto",
  tools: [
    "booking_requests.list",
    "project_visits.list",
    "clients.get",
    "customer_messages.draft",
    "customer_messages.send",
    "staff_tasks.create",
  ],
  toolRisk: {
    "booking_requests.list": "low",
    "project_visits.list": "low",
    "clients.get": "low",
    "customer_messages.draft": "low",
    "customer_messages.send": "critical",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "booking_requests.list": "read",
    "project_visits.list": "read",
    "clients.get": "read",
    "customer_messages.draft": "write",
    "customer_messages.send": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Remind only about visits confirmed in the business's records.",
    "Do not confirm, move or cancel a visit; hand any change request to a person.",
    "Send only within the contact hours the business has configured for this role.",
    "Honour opt-outs immediately and send no further reminders to an opted-out customer.",
  ],
  handoffTo: ["no-show-follow-up"],
  kpis: [
    "Share of confirmed visits reminded before the visit",
    "Share of reminders that led to a change request",
  ],
  sourceRef: "Appointment Setter Agent",
  companyScope: "required",
};
