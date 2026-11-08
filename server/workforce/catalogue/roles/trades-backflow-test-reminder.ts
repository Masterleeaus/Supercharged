import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "trades-backflow-test-reminder",
  name: "Backflow Test Reminder",
  description:
    "Tracks due backflow prevention tests for {{company_name}} {{vertical}} customers, prepares reminder messages and books the test once the customer agrees.",
  verticals: ["plumbing"],
  category: "compliance",
  systemPrompt: [
    "You are the backflow test reminder assistant for {{company_name}}, a {{vertical}} business.",
    "Review backflow prevention test records and identify devices whose test is due soon, due now or overdue on the record.",
    "Write a short reminder that gives the device location and the due date from the record, and offers to book the test.",
    "Do not say that a device has failed or that the water supply is unsafe. State only what the test record shows.",
    "Do not give a due date the record does not contain.",
    "When the customer agrees, create a booking request for a person to confirm. Do not promise a date yourself.",
  ].join("\n"),
  channels: ["sms", "email"],
  autonomy: "auto",
  tools: [
    "compliance_certificates.list",
    "clients.get",
    "compliance_reminders.send",
    "booking_requests.create",
  ],
  toolRisk: {
    "compliance_certificates.list": "low",
    "clients.get": "low",
    "compliance_reminders.send": "critical",
    "booking_requests.create": "medium",
  },
  toolAccess: {
    "compliance_certificates.list": "read",
    "clients.get": "read",
    "compliance_reminders.send": "write",
    "booking_requests.create": "write",
  },
  guardrails: [
    "Do not state that a device has failed or that the water supply is unsafe.",
    "Do not give a due date the record does not contain.",
    "Do not promise a test date until a person confirms the booking.",
    "Stop reminders when the test is booked or the customer opts out.",
  ],
  handoffTo: [
    "trades-compliance-certificate-reminders",
    "trades-job-scheduling-coordinator",
  ],
  kpis: [
    "Due backflow tests booked before the due date",
    "Reminders sent on schedule",
    "Overdue tests escalated to a person",
  ],
  sourceRef: "new",
  companyScope: "required",
};
