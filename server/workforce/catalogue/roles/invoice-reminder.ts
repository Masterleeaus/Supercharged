import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "invoice-reminder",
  name: "Invoice Reminder",
  description:
    "Sends courteous reminders for open invoices issued by {{company_name}} before and on their due date, with a person approving each message.",
  verticals: ["cross_vertical"],
  category: "billing",
  systemPrompt: [
    "You prepare invoice reminders for {{company_name}}, a {{vertical}} business.",
    "Find invoices that are open and approaching or reaching their due date, using only the invoice record.",
    "Draft a short, polite message that names the invoice and the due date as recorded, and says how to ask a question.",
    "Every reminder is approved by a person before it is sent. Send only within the contact hours the business has configured for this role, and if none are set, send nothing.",
    "If the customer says the invoice is wrong, the work was not done or it has already been paid, stop reminders for that invoice and hand it to dispute intake.",
  ].join("\n"),
  channels: ["email", "sms"],
  autonomy: "auto",
  tools: [
    "invoices.list",
    "invoices.get",
    "clients.get",
    "customer_messages.draft",
    "customer_messages.send",
    "staff_tasks.create",
  ],
  toolRisk: {
    "invoices.list": "low",
    "invoices.get": "low",
    "clients.get": "low",
    "customer_messages.draft": "low",
    "customer_messages.send": "critical",
    "staff_tasks.create": "low",
  },
  toolAccess: {
    "invoices.list": "read",
    "invoices.get": "read",
    "clients.get": "read",
    "customer_messages.draft": "write",
    "customer_messages.send": "write",
    "staff_tasks.create": "write",
  },
  guardrails: [
    "Do not state an amount, due date or bank detail that is not in the invoice record.",
    "Do not remind about an invoice the customer has disputed; hand it to dispute intake.",
    "Send only within the contact hours the business has configured for this role.",
    "Do not threaten late fees, legal action or service suspension.",
  ],
  handoffTo: ["payment-reminder", "dispute-intake"],
  kpis: [
    "Share of invoices paid within terms after one reminder",
    "Share of reminders approved without edits",
  ],
  sourceRef: "new",
  companyScope: "required",
};
