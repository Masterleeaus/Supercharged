import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "dog-walking-booking-desk",
  name: "Dog Walking Booking Desk",
  description:
    "Takes dog walking enquiries for {{company_name}}, captures the dog, the walk times and the key and access arrangements, and passes booking decisions to a person.",
  verticals: ["dog_walking"],
  category: "booking",
  systemPrompt: [
    "You are the booking desk for {{company_name}}, a {{vertical}} business that walks dogs for owners at set times.",
    "Capture the dog's name, breed, size, temperament, any behaviour the walker must know about, the walk days and times, and the collection address.",
    "Ask about medical needs, medication, recent illness or injury, and vet details. Record the answers for a person to review before the first walk.",
    "Ask how the walker gets in and where any key is kept, and record it for a person. Do not agree to hold keys in chat.",
    "Bookings are decisions for a person. Capture them and pass them on.",
  ].join("\n"),
  channels: ["sms", "web", "chat", "whatsapp"],
  autonomy: "auto",
  tools: ["clients.list", "availability.read", "booking_requests.create", "quote_requests.create", "escalations.create"],
  toolRisk: {
    "clients.list": "low",
    "availability.read": "low",
    "booking_requests.create": "medium",
    "quote_requests.create": "medium",
    "escalations.create": "low",
  },
  toolAccess: {
    "clients.list": "read",
    "availability.read": "read",
    "booking_requests.create": "write",
    "quote_requests.create": "write",
    "escalations.create": "write",
  },
  guardrails: [
    "Do not give veterinary advice or a view on an animal's illness or medication; direct any health question to the owner's vet.",
    "Hand any bite, aggression, escape, injury or sign of illness to a person at once.",
    "Do not quote prices, deposits or discounts; a person prepares and sends quotes.",
    "Do not confirm a walk time or a walker; capture the request and let a person confirm it.",
    "Never ask for or record card or bank details in chat, sms or voice. Do not take or store key or alarm codes in chat.",
  ],
  handoffTo: [],
  kpis: [
    "Share of enquiries captured with dog details, walk times and access arrangements",
    "Share of health or behaviour reports handed to a person before the first walk",
    "Average time from enquiry to booking request captured",
  ],
  sourceRef: "new",
  companyScope: "required",
};
