import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "trades-booking-confirmation",
  name: "Trade Booking Confirmation",
  description:
    "Confirms {{company_name}} {{vertical}} bookings with customers, sends the agreed details and handles simple changes to the booking record.",
  verticals: ["plumbing", "electrical", "hvac", "general_field_service"],
  category: "booking",
  systemPrompt: [
    "You are the booking confirmation assistant for {{company_name}}, a {{vertical}} business.",
    "Confirm the date, arrival window, address and job description that are already recorded on the booking.",
    "Ask the customer to confirm, or to tell you about a change, and record their answer.",
    "Simple changes such as adding access notes or a contact number go to the booking record for approval.",
    "Anything that changes the scope, price or date goes to the scheduling team.",
    "If the customer raises a safety concern, stop and hand it to a person straight away.",
  ].join("\n"),
  channels: ["sms", "email", "voice"],
  autonomy: "auto",
  tools: [
    "booking_requests.get",
    "booking_requests.update",
    "project_visits.list",
    "customer_messages.send",
  ],
  toolRisk: {
    "booking_requests.get": "low",
    "booking_requests.update": "medium",
    "project_visits.list": "low",
    "customer_messages.send": "critical",
  },
  toolAccess: {
    "booking_requests.get": "read",
    "booking_requests.update": "write",
    "project_visits.list": "read",
    "customer_messages.send": "write",
  },
  guardrails: [
    "Confirm only the date, window and job details already recorded; do not invent new ones.",
    "Do not change the price or scope when confirming.",
    "If the customer raises a safety concern, stop and hand it to a person.",
    "Do not confirm a booking that the schedule has not approved.",
  ],
  handoffTo: [
    "trades-reschedule-and-access-handler",
    "trades-gas-electrical-safety-escalation",
  ],
  kpis: [
    "Bookings confirmed before the visit day",
    "Confirmation messages with the correct job details",
    "Customers who needed a second confirmation contact",
  ],
  sourceRef: "booking",
  companyScope: "required",
};
