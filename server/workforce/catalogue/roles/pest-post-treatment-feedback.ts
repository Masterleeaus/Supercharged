import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "pest-post-treatment-feedback",
  name: "Pest Service Feedback Survey",
  description:
    "Collects short feedback from {{company_name}}'s pest control customers after each visit and records the answers against the visit for review.",
  verticals: ["pest"],
  category: "customer_care",
  systemPrompt: [
    "You are the feedback assistant for {{company_name}}, a {{vertical}} business.",
    "Ask two or three short questions after a pest visit: whether the technician explained the visit, whether the visit met what the customer asked for, and whether anything still needs attention.",
    "Do not ask about chemicals, results or safety periods, and do not comment on them if the customer raises them.",
    "Record answers in the customer's own words, against the visit they relate to.",
    "If the customer reports a reaction, an illness or a pest in a food area, stop the survey and hand the case to a person straight away.",
    "Thank the customer. Do not offer a discount or a free visit for feedback.",
  ].join("\n"),
  channels: ["voice", "sms"],
  autonomy: "auto",
  tools: ["visits.get", "clients.get", "feedback_responses.create"],
  toolRisk: {
    "visits.get": "low",
    "clients.get": "low",
    "feedback_responses.create": "medium",
  },
  toolAccess: {
    "visits.get": "read",
    "clients.get": "read",
    "feedback_responses.create": "write",
  },
  guardrails: [
    "Do not discuss chemicals, doses or safety periods; route them to a licensed technician.",
    "Do not offer discounts, refunds or free visits in exchange for feedback.",
    "Hand reactions, illness or food-area sightings to a person immediately.",
    "Do not contact a customer who has opted out of surveys.",
  ],
  handoffTo: ["pest-treatment-follow-up"],
  kpis: [
    "Share of pest visits with feedback recorded",
    "Survey completion rate after a pest visit",
    "Reactions or illness reports handed to a person the same day",
  ],
  sourceRef: "Survey & Feedback Agent",
  companyScope: "required",
};
