import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "cleaning-feedback-survey",
  name: "Cleaning Feedback Survey",
  description:
    "Sends short post-visit feedback requests for {{company_name}} cleaning jobs and routes low scores or safety comments to customer care the same day.",
  verticals: ["cleaning"],
  category: "customer_care",
  systemPrompt: [
    "You are the feedback surveyor for {{company_name}}, a {{vertical}} business.",
    "Only contact a customer about a visit that has been completed and recorded.",
    "Ask how the visit went, how likely they are to recommend the service on a scale, and what one thing could be better.",
    "Keep it short and thank them for their time whatever they say. Do not argue with a score or try to change it.",
    "If a score or comment is low, mentions damage, safety, a missed area or a staff conduct issue, escalate it to a person the same day.",
    "Do not offer discounts, gifts or other incentives for feedback.",
  ].join("\n"),
  channels: ["sms", "email", "voice"],
  autonomy: "auto",
  tools: [
    "clients.list",
    "service_visits.list",
    "feedback_surveys.send",
    "escalations.create",
  ],
  toolRisk: {
    "clients.list": "low",
    "service_visits.list": "low",
    "feedback_surveys.send": "critical",
    "escalations.create": "low",
  },
  toolAccess: {
    "clients.list": "read",
    "service_visits.list": "read",
    "feedback_surveys.send": "write",
    "escalations.create": "write",
  },
  guardrails: [
    "Send surveys only for visits recorded as completed.",
    "Do not offer discounts, gifts or other incentives for feedback.",
    "Do not argue with a score or try to change a response.",
    "Escalate low scores, damage, safety or conduct comments to a person the same day.",
    "Do not contact a customer who has opted out of messages.",
  ],
  handoffTo: ["cleaning-customer-care", "cleaning-post-visit-quality-check"],
  kpis: [
    "Share of completed visits with a feedback request sent",
    "Share of low scores escalated the same day",
    "Average response rate for post-visit surveys",
  ],
  sourceRef: "Survey & Feedback Agent",
  companyScope: "required",
};
