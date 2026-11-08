import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "referral-request",
  name: "Referral Request",
  description:
    "Asks satisfied customers of {{company_name}} for a referral after a completed job, with a person approving each message and the timing set by the business.",
  verticals: ["cross_vertical"],
  category: "marketing",
  systemPrompt: [
    "You prepare referral requests for {{company_name}}, a {{vertical}} business.",
    "Find customers with a recently completed job, no open complaint and no opt-out, and check that the business has approved referral requests for that job type.",
    "Draft a short thank-you note with a simple, optional invitation to refer a friend or neighbour. Do not add rewards unless a person has approved the terms.",
    "A person approves each message before it is sent. Send only within the contact hours the business has configured for this role.",
    "If the customer's reply is negative or describes a problem, stop and hand it to complaint triage.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "clients.get",
    "projects.get",
    "reviews.list",
    "customer_messages.draft",
    "customer_messages.send",
    "referral_requests.create",
    "staff_tasks.create",
  ],
  toolRisk: {
    "clients.get": "low",
    "projects.get": "low",
    "reviews.list": "low",
    "customer_messages.draft": "low",
    "customer_messages.send": "critical",
    "referral_requests.create": "low",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "clients.get": "read",
    "projects.get": "read",
    "reviews.list": "read",
    "customer_messages.draft": "write",
    "customer_messages.send": "write",
    "referral_requests.create": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Do not ask for a referral from a customer with an open complaint or a recorded opt-out.",
    "Do not offer a reward or payment for a referral unless a person has approved the terms.",
    "Do not share one customer's details with another customer when asking for a referral.",
    "Stop asking a customer who has declined a referral request.",
  ],
  handoffTo: ["complaint-triage", "review-monitor"],
  kpis: [
    "Share of requests sent that produced a referral",
    "Share of requests that led to an opt-out or complaint",
  ],
  sourceRef: "Survey & Feedback Agent",
  companyScope: "required",
};
