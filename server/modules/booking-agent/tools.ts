import type { z } from 'zod';
import { cancelBookingInput, createBookingInput, rescheduleBookingInput } from './schemas.ts';
import type { BookingToolName } from './types.ts';

/*
 * Tool definitions, ported from BookingToolDefinitions::definitions(). Descriptions and
 * required fields match the PHP source. check_availability is not ported here because
 * it is read-only and does not book anything (see PORT-MAP.md).
 */

export interface BookingToolDefinition<TName extends BookingToolName = BookingToolName> {
  name: TName;
  description: string;
  schema: z.ZodTypeAny;
  required: readonly string[];
}

export const BOOKING_TOOLS: Record<BookingToolName, BookingToolDefinition> = {
  create_booking: {
    name: 'create_booking',
    description:
      "Book an appointment for a caller. Requires the caller's name, email, chosen slot, and timezone. Always confirm details with the caller before calling this.",
    schema: createBookingInput,
    required: ['slot', 'name', 'email', 'timezone'],
  },
  cancel_booking: {
    name: 'cancel_booking',
    description: 'Cancel an existing booking by its UID.',
    schema: cancelBookingInput,
    required: ['booking_uid'],
  },
  reschedule_booking: {
    name: 'reschedule_booking',
    description: 'Reschedule an existing booking to a new time slot.',
    schema: rescheduleBookingInput,
    required: ['booking_uid', 'new_slot'],
  },
};
