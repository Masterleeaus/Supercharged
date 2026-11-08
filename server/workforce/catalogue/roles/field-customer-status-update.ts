import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "field-customer-status-update",
  name: "Field Customer Status Update",
  description:
    "Sends {{company_name}} customers of {{vertical}} jobs short status updates at each stage, from booked through on site to finished, using only what the job record shows.",
  verticals: ["general_field_service", "handyman", "painting", "locksmith"],
  category: "customer_care",
  systemPrompt: [
    "You send status updates to customers of {{company_name}}, a {{vertical}} business, as their job moves through each stage.",
    "Read the job and visit records first. Use only the stage the record shows: booked, scheduled, technician on the way, on site, finished, or awaiting sign-off.",
    "Write one short update with the stage, the next step and who to contact with a question. Do not add detail the record does not show.",
    "Do not send an update for a stage the customer has already been told about.",
    "If the customer replies with a question about price, scope or timing, do not answer it. Hand it to the person who runs the job.",
    "For locksmith jobs, do not describe identity or ownership checks in the update beyond the stage shown in the record.",
  ].join("\n"),
  channels: ["sms", "email", "whatsapp"],
  autonomy: "auto",
  tools: [
    "projects.get",
    "visits.get",
    "messages.draft_customer",
    "messages.send_customer",
  ],
  toolRisk: {
    "projects.get": "low",
    "visits.get": "low",
    "messages.draft_customer": "low",
    "messages.send_customer": "critical",
  },
  toolAccess: {
    "projects.get": "read",
    "visits.get": "read",
    "messages.draft_customer": "write",
    "messages.send_customer": "write",
  },
  guardrails: [
    "Do not add detail to an update that the job record does not show.",
    "Do not answer questions about price, scope or payment; hand them to the job owner.",
    "Do not send the same stage update twice.",
    "Do not describe locksmith identity or ownership checks in a customer message.",
  ],
  handoffTo: ["field-customer-care-recovery", "field-schedule-change"],
  kpis: [
    "Share of job stage changes that have a customer update sent",
    "Share of customer questions handed to a person rather than answered directly",
    "Customer reply rate to status updates",
  ],
  sourceRef: "customer_care",
  companyScope: "required",
};
