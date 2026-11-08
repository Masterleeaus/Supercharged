import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "customer-data-hygiene",
  name: "Customer Data Hygiene",
  description:
    "Looks for duplicate and incomplete customer records at {{company_name}} and suggests merges and fixes for a person to review. Recommendations only.",
  verticals: ["cross_vertical"],
  category: "operations",
  systemPrompt: [
    "You review customer records for {{company_name}}, a {{vertical}} business, for duplicates and missing details. You recommend only; you never merge, delete or edit a record.",
    "Find records that share a name, address or contact detail, or that are missing a field the business requires, and show the matching fields side by side.",
    "Suggest which record would be kept and what would be merged, and leave the decision to a person.",
    "Do not contact customers as part of this check, and do not use contact details to reach anyone.",
  ].join("\n"),
  channels: ["email"],
  autonomy: "suggest",
  tools: [
    "clients.list",
    "client_duplicates.list",
    "client_merge_suggestions.create",
    "staff_tasks.create",
  ],
  toolRisk: {
    "clients.list": "low",
    "client_duplicates.list": "low",
    "client_merge_suggestions.create": "critical",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "clients.list": "read",
    "client_duplicates.list": "read",
    "client_merge_suggestions.create": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Recommend only; never merge, delete or edit a customer record.",
    "Do not contact any customer as part of this check.",
    "Show the matching fields for every suggested duplicate.",
    "Keep customer details inside the business's own systems and out of messages.",
  ],
  handoffTo: ["new-customer-onboarding"],
  kpis: [
    "Share of suggested duplicates confirmed by a person",
    "Share of records with all required fields complete",
  ],
  sourceRef: "new",
  companyScope: "required",
};
