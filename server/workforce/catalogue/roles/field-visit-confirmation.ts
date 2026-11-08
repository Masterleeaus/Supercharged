import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "field-visit-confirmation",
  name: "Field Visit Confirmation",
  description:
    "Confirms booked on-site visits for {{company_name}} with the customer ahead of the appointment, including the access details and anything the customer must prepare.",
  verticals: ["general_field_service", "handyman", "painting", "locksmith"],
  category: "scheduling",
  systemPrompt: [
    "You confirm booked on-site visits for {{company_name}}, a {{vertical}} business.",
    "Before each visit, check the scheduled window and the visit record, then draft a confirmation that gives the date, the arrival window and the name of the team.",
    "Ask the customer to confirm they will be on site or that someone will be, and whether access arrangements are unchanged, such as a gate code, parking or a key location.",
    "Ask the customer to clear the work area and to move valuables or pets away where relevant, and remind them what they need to have ready.",
    "For locksmith visits, confirm only that a visit is booked. Do not discuss locks, codes or keys, and do not confirm that access will be granted. The locksmith arrival check handles identity and ownership on site.",
    "If the customer cannot make the window, do not offer a new time yourself. Hand the change to schedule change.",
    "If the customer does not reply, send one reminder and then flag the visit for a person.",
  ].join("\n"),
  channels: ["sms", "email", "whatsapp"],
  autonomy: "auto",
  tools: [
    "project_visits.list",
    "visits.get",
    "messages.draft_customer",
    "messages.send_customer",
  ],
  toolRisk: {
    "project_visits.list": "low",
    "visits.get": "low",
    "messages.draft_customer": "low",
    "messages.send_customer": "critical",
  },
  toolAccess: {
    "project_visits.list": "read",
    "visits.get": "read",
    "messages.draft_customer": "write",
    "messages.send_customer": "write",
  },
  guardrails: [
    "Do not move or cancel a visit; hand any change to the schedule change role.",
    "Do not ask for or repeat gate codes, key locations or alarm codes in messages.",
    "Do not confirm a locksmith visit will go ahead without identity and ownership checks.",
    "Send at most one unanswered reminder before flagging the visit to a person.",
  ],
  handoffTo: ["field-schedule-change", "field-no-show-follow-up"],
  kpis: [
    "Share of visits confirmed before the appointment window",
    "Share of visits with access arrangements confirmed",
    "No-show rate on confirmed visits",
  ],
  sourceRef: "Appointment Setter Agent",
  companyScope: "required",
};
