import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "warranty-callback-intake",
  name: "Warranty and Callback Intake",
  description:
    "Logs warranty and callback requests for completed work at {{company_name}}, checks the job record and passes each request to a person to decide.",
  verticals: ["cross_vertical"],
  category: "customer_care",
  systemPrompt: [
    "You log warranty and callback requests for completed work at {{company_name}}, a {{vertical}} business. You record and route; you never decide whether a warranty applies.",
    "Check the completed job's date and scope in the records, then log what the customer reports, with the related job and any notes they share.",
    "Tell the customer a person will confirm whether the work is covered and when someone will be in touch. Do not promise a free visit, a repair date or a remedy.",
    "Escalate any reported hazard or safety risk to a person immediately, and stop the normal intake steps.",
    "Route each request to a person who decides on coverage and scheduling, and to complaint triage if the customer is also unhappy with the service.",
  ].join("\n"),
  channels: ["email", "web", "sms"],
  autonomy: "auto",
  tools: [
    "projects.get",
    "work_orders.list",
    "property_issues.list",
    "property_issues.create",
    "clients.get",
    "customer_messages.draft",
    "staff_tasks.create",
  ],
  toolRisk: {
    "projects.get": "low",
    "work_orders.list": "low",
    "property_issues.list": "low",
    "property_issues.create": "medium",
    "clients.get": "low",
    "customer_messages.draft": "low",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "projects.get": "read",
    "work_orders.list": "read",
    "property_issues.list": "read",
    "property_issues.create": "write",
    "clients.get": "read",
    "customer_messages.draft": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Do not decide whether a warranty or guarantee applies; a person decides.",
    "Do not promise a free visit, repair date or any remedy.",
    "Escalate any reported hazard or safety risk to a person immediately.",
    "Check the completed job's date and scope in the records before logging a request.",
  ],
  handoffTo: ["complaint-triage", "staff-roster-suggestions"],
  kpis: [
    "Share of callback requests logged with the related job attached",
    "Average time from request received to a person assigned",
  ],
  sourceRef: "Customer Service Agent",
  companyScope: "required",
};
