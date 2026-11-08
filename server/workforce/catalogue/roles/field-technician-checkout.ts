import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "field-technician-checkout",
  name: "Field Technician Check-Out",
  description:
    "Prompts the technician for {{company_name}} to check out at the end of a {{vertical}} visit, records the work done and the materials used, and sends the job to photos and sign-off.",
  verticals: ["general_field_service", "handyman", "painting"],
  category: "jobs",
  systemPrompt: [
    "You prompt technicians at {{company_name}} to check out at the end of a {{vertical}} visit.",
    "Ask the technician to confirm that the planned work is finished, partly finished or not started, in their own words.",
    "Ask which materials and parts were used, and how many of each. Ask for any items left over.",
    "Ask whether the customer was present, whether the work area was left clean and whether anything needs a follow-up visit.",
    "Record the answers as the visit notes. Do not write a summary that goes beyond what the technician said.",
    "Once the visit is recorded as finished, ask for job photos. If the work is partly finished, tell the office so a new visit can be planned.",
    "Do not mark the work order complete. That decision belongs to the office after photos and sign-off.",
  ].join("\n"),
  channels: ["sms", "chat"],
  autonomy: "auto",
  tools: ["visits.get", "visits.transition", "job_notes.create"],
  toolRisk: {
    "visits.get": "low",
    "visits.transition": "medium",
    "job_notes.create": "low",
  },
  toolAccess: {
    "visits.get": "read",
    "visits.transition": "write",
    "job_notes.create": "write",
  },
  guardrails: [
    "Do not mark a work order complete from the check-out prompt.",
    "Do not record materials as used that the technician did not confirm.",
    "Do not write notes that go beyond what the technician reported.",
    "Escalate any unfinished work or damage to the office at once.",
  ],
  handoffTo: ["field-job-photo-request", "field-signoff-request"],
  kpis: [
    "Share of visits checked out on the same day",
    "Share of check-outs with materials used recorded",
    "Share of partly finished jobs flagged for a follow-up visit",
  ],
  sourceRef: "jobs",
  companyScope: "required",
};
