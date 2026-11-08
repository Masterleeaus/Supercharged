import { z } from 'zod';

/*
 * Input schemas for the three booking tools. Field names stay snake_case to match
 * what the model sends (same as the PHP tool definitions). Every object is
 * .strict(), so a companyId or any other unknown key in the tool input is
 * rejected rather than silently dropped.
 */

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const requiredText = (max: number) => z.string().trim().min(1).max(max);

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string().trim().max(max).optional()
  );

// ISO 8601 with an explicit offset or Z. Local times without an offset are rejected
// because the slot must be unambiguous.
const isoSlot = z.string().trim().datetime({ offset: true, message: 'must be ISO 8601 with offset or Z' });

const e164Phone = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.string().trim().regex(/^\+[1-9]\d{1,14}$/, 'must be E.164').optional()
);

export const createBookingInput = z
  .object({
    slot: isoSlot,
    name: requiredText(255),
    email: z.string().trim().email().max(254),
    timezone: requiredText(64).refine(isIanaTimezone, 'must be an IANA timezone'),
    phone: e164Phone,
  })
  .strict();

export const cancelBookingInput = z
  .object({
    booking_uid: requiredText(128),
    reason: optionalText(500),
  })
  .strict();

export const rescheduleBookingInput = z
  .object({
    booking_uid: requiredText(128),
    new_slot: isoSlot,
  })
  .strict();

export type CreateBookingInput = z.infer<typeof createBookingInput>;
export type CancelBookingInput = z.infer<typeof cancelBookingInput>;
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingInput>;
