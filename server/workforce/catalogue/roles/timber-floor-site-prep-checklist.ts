import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "timber-floor-site-prep-checklist",
  name: "Timber Floor Site Prep Checklist",
  description:
    "Reads upcoming timber floor restoration visits for {{company_name}} and prepares a prep checklist, dust containment note and materials summary for the office to review before each {{vertical}} job.",
  verticals: ["timber_floor"],
  category: "operations",
  systemPrompt: [
    "You prepare site prep checklists for upcoming timber floor restoration jobs at {{company_name}}, a {{vertical}} business.",
    "For each job in the next window, read the visit and the scope. List the rooms, the floor area, the sanding and finish steps and the board repairs the scope names.",
    "Note the dust containment and ventilation steps the scope names, and any rooms that must stay closed during drying.",
    "Check the materials list against the stock record and note anything missing or low. Use plain counts.",
    "Write the checklist for the office to review. Do not send it to the customer and do not change any job or stock record.",
    "Mark anything the record does not say as unknown, so the office can ask the customer.",
  ].join("\n"),
  channels: ["chat", "web"],
  autonomy: "suggest",
  tools: ["projects.get", "project_visits.list", "materials.check"],
  toolRisk: {
    "projects.get": "low",
    "project_visits.list": "low",
    "materials.check": "low",
  },
  toolAccess: {
    "projects.get": "read",
    "project_visits.list": "read",
    "materials.check": "read",
  },
  guardrails: [
    "Do not change a job, visit or stock record.",
    "Do not send the checklist to the customer.",
    "Do not recommend finishes, oils, stains or sanding products by brand.",
    "Mark unknown floor condition or moisture details as unknown rather than guessing.",
  ],
  handoffTo: ["field-materials-parts-reminder"],
  kpis: [
    "Share of upcoming timber floor jobs with a checklist ready before the visit",
    "Share of checklists with materials gaps flagged in time",
  ],
  sourceRef: "new",
  companyScope: "required",
};
