/**
 * Appointment status transitions. The PHP runtime never checked transitions: any status could be written
 * over any other. The allowed set below is the minimum the PHP code paths imply:
 *   book() creates confirmed, waitlist() creates waitlisted, cancellation sets cancelled.
 * A waitlisted entry can be promoted to confirmed once its slot is free. cancelled is terminal.
 */
import { ChatbotError } from "../chatbot-scope.ts";
import type { AppointmentStatus } from "./types.ts";

const ALLOWED: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> = {
  confirmed: ["cancelled"],
  waitlisted: ["confirmed", "cancelled"],
  cancelled: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Throws a 409 ChatbotError when the transition is not allowed. */
export function assertTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (!canTransition(from, to)) {
    throw new ChatbotError(`Appointment cannot move from ${from} to ${to}`, 409);
  }
}
