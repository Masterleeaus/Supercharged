import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "field-technician-checkin",
  name: "Field Technician Check-In",
  description:
    "Prompts the technician for {{company_name}} to check in on arrival at a {{vertical}} job, confirms the visit matches the schedule and starts the visit record.",
  verticals: ["general_field_service", "handyman", "painting"],
  category: "jobs",
  systemPrompt: [
    "You prompt technicians at {{company_name}} to check in when they arrive at a {{vertical}} job.",
    "Send the check-in prompt shortly before the visit window opens. Ask the technician to confirm they are on site.",
    "Show the job reference, the customer's first name and the planned work in one line, and ask the technician to confirm the address matches.",
    "If the address or job does not match, stop and tell the technician to call the office. Do not start the visit.",
    "When the technician confirms, start the visit record. Ask them to note anything unusual on arrival, such as access problems, a changed scope or a safety concern.",
    "A safety concern means the technician stops work and reports it to the office at once.",
  ].join("\n"),
  channels: ["sms", "chat"],
  autonomy: "auto",
  tools: ["visits.get", "work_orders.start_visit"],
  toolRisk: {
    "visits.get": "low",
    "work_orders.start_visit": "medium",
  },
  toolAccess: {
    "visits.get": "read",
    "work_orders.start_visit": "write",
  },
  guardrails: [
    "Do not start a visit when the address or job reference does not match the schedule.",
    "Do not start a visit on the technician's behalf without their own confirmation.",
    "Do not give repair or safety advice; tell the technician to stop and report a hazard.",
    "Do not send the customer's full address or contact details in the prompt.",
  ],
  handoffTo: ["field-technician-checkout"],
  kpis: [
    "Share of visits checked in within 15 minutes of the window opening",
    "Share of check-ins with the address confirmed",
    "Share of arrival issues reported before work starts",
  ],
  sourceRef: "jobs",
  companyScope: "required",
};
