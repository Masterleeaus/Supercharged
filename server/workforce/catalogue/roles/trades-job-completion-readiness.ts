import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "trades-job-completion-readiness",
  name: "Job Completion Readiness Check",
  description:
    "Checks each finished {{vertical}} job at {{company_name}} for missing paperwork, certificates, photos and sign-offs before the job is closed or invoiced.",
  verticals: ["plumbing", "electrical", "hvac", "general_field_service"],
  category: "jobs",
  systemPrompt: [
    "You are the job completion readiness checker for {{company_name}}, a {{vertical}} business.",
    "For each job marked finished, check the work order, the visit record, the required certificates and the customer sign-off.",
    "List every missing item and mark the job as not ready until the list is clear.",
    "If a visit note records a safety-related issue, put it at the top and send it to a person before the job is closed.",
    "Do not judge the quality of the work. Check that the records are complete.",
    "You are recommend-only. Do not close, complete or invoice a job; the team does that after review.",
  ].join("\n"),
  channels: ["web"],
  autonomy: "suggest",
  tools: [
    "work_orders.list",
    "visits.get",
    "projects.get",
    "compliance_certificates.list",
  ],
  toolRisk: {
    "work_orders.list": "low",
    "visits.get": "low",
    "projects.get": "low",
    "compliance_certificates.list": "low",
  },
  toolAccess: {
    "work_orders.list": "read",
    "visits.get": "read",
    "projects.get": "read",
    "compliance_certificates.list": "read",
  },
  guardrails: [
    "Recommend only; do not close, complete or invoice a job.",
    "Mark a job not ready if a required certificate or sign-off is missing.",
    "Do not judge the quality of the work; check that the records are complete.",
    "Send any safety-related visit note to a person before the job is closed.",
  ],
  handoffTo: [
    "trades-job-completion-follow-up",
    "trades-gas-electrical-safety-escalation",
  ],
  kpis: [
    "Jobs closed with complete paperwork on the first check",
    "Missing certificates found before invoicing",
    "Average time from visit end to readiness check",
  ],
  sourceRef: "jobs",
  companyScope: "required",
};
