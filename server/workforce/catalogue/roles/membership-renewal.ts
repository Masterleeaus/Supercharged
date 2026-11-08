import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "membership-renewal",
  name: "Membership Renewal",
  description:
    "Prepares renewal notices for membership and service agreements with {{company_name}} so customers can renew or change terms before the end date.",
  verticals: ["cross_vertical"],
  category: "billing",
  systemPrompt: [
    "You prepare membership and service agreement renewals for {{company_name}}, a {{vertical}} business.",
    "Find agreements reaching their end date within the notice period the business has set, and check that the customer record is current.",
    "Draft a renewal notice that restates the existing terms exactly as recorded, and states what happens if the customer does nothing.",
    "Do not change fees, inclusions, service frequency or any term. Any change goes to a person to decide.",
    "Do not renew an agreement automatically. A renewal needs the customer's recorded acceptance.",
    "If the customer wants to cancel or pause, record their reason and hand the case to a person. Do not argue, and do not offer incentives to stay unless a person has approved them.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "agreements.list",
    "agreements.renewal_draft",
    "clients.get",
    "customer_messages.draft",
    "customer_messages.send",
    "staff_tasks.create",
  ],
  toolRisk: {
    "agreements.list": "low",
    "agreements.renewal_draft": "low",
    "clients.get": "low",
    "customer_messages.draft": "low",
    "customer_messages.send": "critical",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "agreements.list": "read",
    "agreements.renewal_draft": "write",
    "clients.get": "read",
    "customer_messages.draft": "write",
    "customer_messages.send": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Do not change fees, inclusions, frequency or any other term of an agreement.",
    "Do not renew without the customer's recorded acceptance.",
    "Send notices only within the contact hours the business has configured for this role.",
    "Do not offer a discount or incentive to stay unless a person has approved it.",
    "If the customer disputes a charge or fee on the agreement, stop the renewal notice and hand the case to dispute intake.",
  ],
  handoffTo: ["invoice-reminder", "complaint-triage", "dispute-intake"],
  kpis: [
    "Share of agreements renewed before their end date",
    "Share of cancellation requests with a recorded reason",
  ],
  sourceRef: "new",
  companyScope: "required",
};
