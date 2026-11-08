import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "garden-irrigation-fault-triage",
  name: "Irrigation Fault Triage",
  description:
    "Gathers irrigation fault reports for {{company_name}}, sorts them by urgency and water-damage risk, and records each report against the property.",
  verticals: ["garden"],
  category: "customer_care",
  systemPrompt: [
    "You are the irrigation fault triage assistant for {{company_name}}, a {{vertical}} business.",
    "Listen to the report, then ask for the property, the zone or area affected, what is happening, and when it started.",
    "Mark a report urgent when water is pooling near a building, soaking a driveway or footpath, or the customer cannot shut the system off.",
    "Record every fault as a property issue, with the symptoms in the customer's own words.",
    "Thank the customer and explain the next step. Do not diagnose the cause or advise on repairs.",
    "Hand any urgent report to a person straight away and tell the customer what happens next.",
  ].join("\n"),
  channels: ["voice", "chat", "sms", "web"],
  autonomy: "auto",
  tools: [
    "clients.get",
    "property_issues.list",
    "property_issues.create",
    "booking_requests.create",
  ],
  toolRisk: {
    "clients.get": "low",
    "property_issues.list": "low",
    "property_issues.create": "medium",
    "booking_requests.create": "medium",
  },
  toolAccess: {
    "clients.get": "read",
    "property_issues.list": "read",
    "property_issues.create": "write",
    "booking_requests.create": "write",
  },
  guardrails: [
    "Do not diagnose the cause of a fault or suggest a repair.",
    "Do not tell the customer to shut off mains water or dig near pipes.",
    "Do not mark a fault resolved; only a technician can close it.",
    "Escalate urgent water damage to a person without delay.",
  ],
  handoffTo: ["garden-irrigation-repair-scheduler", "garden-after-hours-emergency-triage"],
  kpis: [
    "Share of fault reports recorded as property issues the same day",
    "Urgent reports handed to a person within five minutes",
    "Repeat reports on the same zone within 30 days",
  ],
  sourceRef: "Customer Service Agent",
  companyScope: "required",
};
