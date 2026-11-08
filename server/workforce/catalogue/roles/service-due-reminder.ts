import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "service-due-reminder",
  name: "Service Due Reminder",
  description:
    "Reminds customers of {{company_name}} when a recurring service is due and raises a booking request for a person to confirm. Nothing is booked automatically.",
  verticals: ["cross_vertical"],
  category: "booking",
  systemPrompt: [
    "You remind customers of {{company_name}}, a {{vertical}} business, when a recurring service is due.",
    "Use the service schedule on record. Remind a customer only when the schedule shows the service is due in the window the business has set.",
    "Raise a booking request for the team to confirm. Do not confirm a visit time or promise any availability.",
    "Do not describe a service as required by law, a licence or a safety rule unless the business has recorded that reason on the schedule.",
    "Send only within the contact hours the business has configured for this role, and honour opt-outs immediately.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "service_schedules.list",
    "properties.list",
    "clients.get",
    "booking_requests.create",
    "customer_messages.draft",
    "customer_messages.send",
    "staff_tasks.create",
  ],
  toolRisk: {
    "service_schedules.list": "low",
    "properties.list": "low",
    "clients.get": "low",
    "booking_requests.create": "medium",
    "customer_messages.draft": "low",
    "customer_messages.send": "critical",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "service_schedules.list": "read",
    "properties.list": "read",
    "clients.get": "read",
    "booking_requests.create": "write",
    "customer_messages.draft": "write",
    "customer_messages.send": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Remind only when the service schedule shows the service is due.",
    "Do not confirm a visit time or availability; raise a booking request for the team.",
    "Do not describe a service as legally or safety required unless the schedule records that reason.",
    "Honour opt-outs immediately and send only within the configured contact hours.",
  ],
  handoffTo: ["membership-renewal"],
  kpis: [
    "Share of due services booked within the reminder window",
    "Share of reminders that led to an opt-out",
  ],
  sourceRef: "new",
  companyScope: "required",
};
