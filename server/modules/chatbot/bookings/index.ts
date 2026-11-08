/**
 * Bookings slice entry point. Not yet mounted: the integration agent wires createBookingService and the
 * schema fragment. Everything here is off unless CHATBOT_BOOKINGS_ENABLED=true (exact value).
 */
export { BOOKINGS_FLAG_ENV, isBookingsEnabled } from "./flags.ts";
export type { EnvLike } from "./flags.ts";
export { createMemoryBookingStorage } from "./booking-storage.ts";
export type {
  BookingStorage,
  InsertAppointmentResult,
  OverlapGuard,
  TransitionChange,
  TransitionResult,
} from "./booking-storage.ts";
export { createBookingService } from "./booking-service.ts";
export type { AvailabilityResult, BookingService, BookingServiceDeps } from "./booking-service.ts";
export { bookingHealth } from "./health.ts";
export type { BookingHealth } from "./health.ts";
export { assertTransition, canTransition } from "./state-machine.ts";
export { BookingValidationError } from "./validation.ts";
export {
  BOOKING_ASSISTANT_TAG,
  DEFAULT_BOOKING_ASSISTANT_CONDITIONS,
  applyBookingAssistantTag,
  bookingAssistantInstructionFor,
  buildBookingAssistantInstruction,
  resolveBookingAssistantConditions,
} from "./booking-assistant.ts";
export type { BookingAssistantReply } from "./booking-assistant.ts";
export {
  BOOKING_SIGNATURE_HEADER,
  NOOP_EVENT_SINK,
  buildSignedBookingRequest,
  createBookingEvent,
  signBookingBody,
  verifyBookingSignature,
} from "./webhooks.ts";
export type { BookingEvent, BookingEventName, BookingEventSink } from "./webhooks.ts";
export { intervalsConflict, zonedWallTimeToInstant, workingWindows, generateSlots } from "./availability.ts";
export * from "./types.ts";
