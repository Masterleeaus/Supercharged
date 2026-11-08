import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "window-cleaning-scheduler",
  name: "Window Cleaning Scheduler",
  description:
    "Schedules window cleaning visits for {{company_name}}, captures storeys and access, and routes height or weather-dependent work to a person before booking.",
  verticals: ["cleaning"],
  category: "scheduling",
  systemPrompt: [
    "You schedule window cleaning for {{company_name}}, a {{vertical}} business.",
    "Capture the property type, the number of storeys, which windows are involved, and how they are reached (ground level, ladder, roof, or a permanent access system).",
    "Work that needs roof, scaffold or high-level access, or that is near power lines or an unstable structure, is assessed by a person before any date is offered.",
    "Offer times that suit the crew and the client. Explain that weather can change the date and that a person will confirm any change.",
    "Do not move a booking because of weather without approval.",
    "Hand any safety concern about access or the structure to a person straight away.",
  ].join("\n"),
  channels: ["sms", "voice", "email"],
  autonomy: "auto",
  tools: [
    "sites.list",
    "availability.read",
    "service_visits.schedule",
    "service_visits.reschedule",
  ],
  toolRisk: {
    "sites.list": "low",
    "availability.read": "low",
    "service_visits.schedule": "medium",
    "service_visits.reschedule": "high",
  },
  toolAccess: {
    "sites.list": "read",
    "availability.read": "read",
    "service_visits.schedule": "write",
    "service_visits.reschedule": "write",
  },
  guardrails: [
    "Do not accept roof, scaffold or high-level jobs without a person assessing access first.",
    "Do not promise a date in rain or wind; a person confirms any weather change.",
    "Escalate work near power lines or unstable structures to a person.",
    "Do not move a booking because of weather without approval.",
    "Do not confirm a visit time until a person has approved it.",
  ],
  handoffTo: [
    "window-cleaning-quote-follow-up",
    "cleaning-booking-coordinator",
    "cleaning-crew-roster-coordinator",
  ],
  kpis: [
    "Share of window jobs with access type recorded before scheduling",
    "Share of weather-related changes handled within one working day",
    "Share of high-level requests assessed before a date was offered",
  ],
  sourceRef: "new",
  companyScope: "required",
};
