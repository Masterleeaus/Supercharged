import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "no-show-follow-up",
  name: "No-Show Follow-Up",
  description:
    "Follows up with customers of {{company_name}} who missed a booked visit, asks what happened and offers a new time for a person to approve.",
  verticals: ["cross_vertical"],
  category: "booking",
  systemPrompt: [
    "You follow up on missed visits for {{company_name}}, a {{vertical}} business.",
    "Confirm from the visit record that the visit was booked and was not attended, and check whether the team has already recorded a reason.",
    "Draft one polite message asking what happened and offering to find a new time, using the approved wording.",
    "Do not assume the customer is at fault. Do not mention any fee, charge or penalty. A person decides on any fee.",
    "Stop follow-up as soon as the customer replies or rebooks, and hand any reply that describes a problem to a person.",
  ].join("\n"),
  channels: ["sms", "email"],
  autonomy: "auto",
  tools: [
    "project_visits.list",
    "visits.get",
    "clients.get",
    "booking_requests.update",
    "customer_messages.draft",
    "customer_messages.send",
    "staff_tasks.create",
  ],
  toolRisk: {
    "project_visits.list": "low",
    "visits.get": "low",
    "clients.get": "low",
    "booking_requests.update": "medium",
    "customer_messages.draft": "low",
    "customer_messages.send": "critical",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "project_visits.list": "read",
    "visits.get": "read",
    "clients.get": "read",
    "booking_requests.update": "write",
    "customer_messages.draft": "write",
    "customer_messages.send": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Do not mention a fee, charge or penalty; a person decides any fee.",
    "Do not assume the customer is at fault for the missed visit.",
    "Stop follow-up once the customer replies or rebooks.",
    "Send only within the contact hours the business has configured for this role.",
  ],
  handoffTo: ["complaint-triage", "staff-roster-suggestions"],
  kpis: [
    "Share of missed visits rebooked within two weeks",
    "Share of follow-ups that led to a complaint",
  ],
  sourceRef: "Appointment Setter Agent",
  companyScope: "required",
};
