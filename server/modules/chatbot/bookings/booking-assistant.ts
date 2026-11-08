/**
 * Booking-assistant conditions and reply tagging. Port of the booking-assistant parts of the Commerce Crew
 * chatbot generators (OpenAIGenerator, AnthropicGenerator, GeminiGenerator) and the reply handler in
 * ChatbotApplicationController.
 *
 * The model is told to end a reply with the tag when a condition applies. The server removes the tag and
 * reports it, so the UI can show the booking button. The prompt text is written for this port, not copied.
 * Each generator in PHP repeated the same logic. Here it lives once.
 */
import { isBookingsEnabled, type EnvLike } from "./flags.ts";

export const BOOKING_ASSISTANT_TAG = "[booking-assistant]";

/** Same default conditions as the PHP generators. */
export const DEFAULT_BOOKING_ASSISTANT_CONDITIONS: readonly string[] = [
  "User explicitly asks to schedule a meeting",
  "User asks for examples, use cases, or real demos",
  "User mentions team size, enterprise, or agency use",
  "User expresses hesitation, doubt, or objections",
  "User explicitly asks to see how it works",
];

const MAX_CONDITIONS = 20;
const MAX_CONDITION_LENGTH = 200;
const TRAILING_TAG_RE = /\s*\[booking-assistant\]\s*$/u;

/**
 * Stored conditions win when at least one usable string is present. Otherwise the defaults apply. PHP
 * checked truthiness of the array, so an empty array fell back to the defaults; this keeps that.
 */
export function resolveBookingAssistantConditions(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [...DEFAULT_BOOKING_ASSISTANT_CONDITIONS];
  const cleaned: string[] = [];
  for (const item of stored) {
    if (typeof item !== "string") continue;
    // Newlines would break the one-item-per-line list in the prompt.
    const text = item.replace(/\s+/g, " ").trim().slice(0, MAX_CONDITION_LENGTH);
    if (text.length > 0 && !cleaned.includes(text)) cleaned.push(text);
    if (cleaned.length === MAX_CONDITIONS) break;
  }
  return cleaned.length > 0 ? cleaned : [...DEFAULT_BOOKING_ASSISTANT_CONDITIONS];
}

export function buildBookingAssistantInstruction(conditions: readonly string[]): string {
  const list = conditions.map((c) => `- ${c}`).join("\n");
  return [
    "BOOKING ASSISTANT TRIGGER",
    "",
    `If the user wants to book or schedule something, end your reply with exactly ${BOOKING_ASSISTANT_TAG}, preceded by one space.`,
    "Do not ask for booking details such as duration or location in this reply.",
    "",
    "Conditions (any one is enough):",
    list,
    "",
    "Rules:",
    "- Give your normal reply first. Add the tag only when a condition applies.",
    "- Put the tag only at the plain-text end of the reply, never inside code, JSON or quotes.",
    `- Write the tag exactly as ${BOOKING_ASSISTANT_TAG}.`,
    "- Do not explain the tag and do not describe any booking interface.",
    "- If you refuse for safety or policy reasons, refuse as normal and add the tag only if a condition applies.",
  ].join("\n");
}

/**
 * The system instruction for one chatbot, or null when no instruction should be sent. Null is returned
 * when the bookings feature flag is off or when the chatbot is not a booking assistant.
 */
export function bookingAssistantInstructionFor(
  chatbot: { isBookingAssistant: boolean; storedConditions: unknown },
  env: EnvLike = process.env,
): string | null {
  if (!isBookingsEnabled(env) || !chatbot.isBookingAssistant) return null;
  return buildBookingAssistantInstruction(resolveBookingAssistantConditions(chatbot.storedConditions));
}

export interface BookingAssistantReply {
  /** True when the model added the trailing tag. */
  showBookingButton: boolean;
  /** The reply to store and show. The tag is removed only when the assistant is active. */
  message: string;
}

/**
 * Removes a trailing tag from a reply when the chatbot is a booking assistant. When the assistant is off,
 * the reply passes through unchanged and the tag is never treated as a signal.
 */
export function applyBookingAssistantTag(reply: string, assistantActive: boolean): BookingAssistantReply {
  if (!assistantActive) return { showBookingButton: false, message: reply };
  if (TRAILING_TAG_RE.test(reply)) {
    return { showBookingButton: true, message: reply.replace(TRAILING_TAG_RE, "") };
  }
  return { showBookingButton: false, message: reply };
}
