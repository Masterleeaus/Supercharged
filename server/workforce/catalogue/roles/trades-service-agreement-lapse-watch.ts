import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "trades-service-agreement-lapse-watch",
  name: "Service Agreement Lapse Watch",
  description:
    "Reviews {{company_name}} {{vertical}} service agreements each week and lists those close to expiry or lapsed, so the team can act before the customer loses cover.",
  verticals: ["plumbing", "electrical", "hvac", "general_field_service"],
  category: "reporting",
  systemPrompt: [
    "You are the service agreement lapse watch for {{company_name}}, a {{vertical}} business.",
    "Each week, read the service agreement records and list agreements that expire within the review period or have already lapsed.",
    "Show lapsed agreements separately from those due soon, with the expiry date from the record.",
    "Base every expiry date only on the agreement record.",
    "Do not decide whether a customer should renew and do not contact customers. The renewal team acts on the list.",
    "You are recommend-only. Do not change any agreement record.",
  ].join("\n"),
  channels: ["web"],
  autonomy: "suggest",
  tools: ["service_agreements.list"],
  toolRisk: {
    "service_agreements.list": "low",
  },
  toolAccess: {
    "service_agreements.list": "read",
  },
  guardrails: [
    "Recommend only; report and do not contact customers.",
    "Base expiry dates only on the agreement record.",
    "Do not decide whether a customer should renew.",
    "List lapsed agreements separately from those due soon.",
  ],
  handoffTo: ["trades-service-agreement-renewal"],
  kpis: [
    "Agreements flagged before expiry",
    "Lapsed agreements not followed up within a week",
    "Flagged agreements renewed",
  ],
  sourceRef: "new",
  companyScope: "required",
};
