/**
 * Input schemas for the booking routes. Every object is .strict(), so a companyId in the body, the query
 * or the params is rejected with 400 rather than dropped. Tenancy comes only from the injected company
 * resolver in router.ts.
 */
import { z } from "zod";

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_METADATA_JSON = 8192;

export const bookingIdParam = z.string().regex(ID_PATTERN);

/** ISO 8601 with an explicit offset or Z. Local times are rejected so the slot is unambiguous. */
const isoInstant = z.string().trim().datetime({ offset: true, message: "must be ISO 8601 with offset or Z" });

const writableStatus = z.enum(["confirmed", "waitlisted"]);

const metadata = z
  .record(z.string().min(1).max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_METADATA_JSON, {
    message: `metadata must serialise to at most ${MAX_METADATA_JSON} characters`,
  });

const endAfterStart = (value: { startsAt?: string; endsAt?: string }) =>
  value.startsAt === undefined || value.endsAt === undefined
    ? true
    : Date.parse(value.endsAt) > Date.parse(value.startsAt);

const endAfterStartMessage = { message: "endsAt must be after startsAt", path: ["endsAt"] };

const createShape = {
  calendarId: z.number().int().positive(),
  startsAt: isoInstant,
  endsAt: isoInstant,
  status: writableStatus.optional(),
  metadata: metadata.optional(),
};

export const createBookingBody = z
  .object(createShape)
  .strict()
  .refine(endAfterStart, endAfterStartMessage)
  .transform((value) => ({ ...value, status: value.status ?? ("confirmed" as const), metadata: value.metadata ?? {} }));

export const updateBookingBody = z
  .object({
    startsAt: isoInstant.optional(),
    endsAt: isoInstant.optional(),
    status: writableStatus.optional(),
    metadata: metadata.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field is required" })
  .refine(endAfterStart, endAfterStartMessage);

export const cancelBookingBody = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const listBookingsQuery = z
  .object({
    calendar_id: z.coerce.number().int().positive().optional(),
    status: z.enum(["confirmed", "waitlisted", "cancelled", "all"]).optional(),
    from: isoInstant.optional(),
    to: isoInstant.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const updateAssistantSettingsBody = z
  .object({
    calendlyAccessToken: z.string().trim().min(1).max(512).nullable().optional(),
    bookingAssistantConditions: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field is required" });

export type CreateBookingBody = z.infer<typeof createBookingBody>;
export type UpdateBookingBody = z.infer<typeof updateBookingBody>;
export type CancelBookingBody = z.infer<typeof cancelBookingBody>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuery>;
export type UpdateAssistantSettingsBody = z.infer<typeof updateAssistantSettingsBody>;
