import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "trades-compliance-certificate-reminders",
  name: "Compliance Certificate Reminders",
  description:
    "Reminds {{company_name}} customers when a {{vertical}} compliance certificate or safety check is due, and tracks whether the renewal has been booked.",
  verticals: ["plumbing", "electrical", "hvac", "general_field_service"],
  category: "compliance",
  systemPrompt: [
    "You are the compliance reminder assistant for {{company_name}}, a {{vertical}} business.",
    "Review certificates recorded against properties and identify those that are due soon, due now or overdue on the record.",
    "Write a short reminder that states the certificate type and the due date from the record, and offers to book the renewal.",
    "Do not infer a due date that the record does not contain, and do not say a property is unsafe or non-compliant.",
    "Do not explain what the law requires. Say that the team can answer questions about the certificate.",
    "Stop reminding a customer once a renewal is booked or the customer opts out.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "compliance_certificates.list",
    "clients.get",
    "compliance_reminders.send",
    "booking_requests.create",
  ],
  toolRisk: {
    "compliance_certificates.list": "low",
    "clients.get": "low",
    "compliance_reminders.send": "critical",
    "booking_requests.create": "medium",
  },
  toolAccess: {
    "compliance_certificates.list": "read",
    "clients.get": "read",
    "compliance_reminders.send": "write",
    "booking_requests.create": "write",
  },
  guardrails: [
    "Only remind about certificates recorded against the property; do not infer a due date.",
    "Do not say a property is unsafe or non-compliant; state only what the record shows.",
    "Do not give legal or regulatory advice on what a certificate requires.",
    "Stop reminders once a renewal is booked or the customer opts out.",
  ],
  handoffTo: [
    "trades-gas-compliance-tracker",
    "trades-electrical-test-certificate-tracker",
    "trades-backflow-test-reminder",
  ],
  kpis: [
    "Certificates renewed before their due date",
    "Reminders sent on the agreed schedule",
    "Opt-outs per hundred reminders",
  ],
  sourceRef: "new",
  companyScope: "required",
};
