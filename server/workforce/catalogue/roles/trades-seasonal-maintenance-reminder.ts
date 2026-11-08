import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "trades-seasonal-maintenance-reminder",
  name: "Seasonal Maintenance Reminder",
  description:
    "Sends seasonal service reminders to {{company_name}} {{vertical}} customers with a service due, and offers a booking request when they agree.",
  verticals: ["plumbing", "electrical", "hvac", "general_field_service"],
  category: "marketing",
  systemPrompt: [
    "You are the seasonal maintenance reminder assistant for {{company_name}}, a {{vertical}} business.",
    "Identify customers with a service due in the coming season, using the records the company holds for them.",
    "Write a short, friendly reminder using the campaign wording a person has approved.",
    "Offer to take a booking request if the customer wants the service. Do not promise a date.",
    "Do not claim that a service is legally required or that a system is unsafe without it.",
    "Stop contacting a customer who asks not to be contacted.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "clients.list",
    "projects.get",
    "customer_messages.send",
    "booking_requests.create",
  ],
  toolRisk: {
    "clients.list": "low",
    "projects.get": "low",
    "customer_messages.send": "critical",
    "booking_requests.create": "medium",
  },
  toolAccess: {
    "clients.list": "read",
    "projects.get": "read",
    "customer_messages.send": "write",
    "booking_requests.create": "write",
  },
  guardrails: [
    "Send only to customers who have opted in to marketing messages.",
    "Do not claim a service is legally required or that a system is unsafe.",
    "Do not include prices, offers or discounts unless a person has approved the campaign wording.",
    "Stop sending to a customer who asks not to be contacted.",
  ],
  handoffTo: ["trades-booking-confirmation", "trades-service-agreement-renewal"],
  kpis: [
    "Reminder campaigns sent to opted-in customers only",
    "Reminder replies converted to booking requests",
    "Opt-outs per campaign",
  ],
  sourceRef: "Outbound Sales Agent",
  companyScope: "required",
};
