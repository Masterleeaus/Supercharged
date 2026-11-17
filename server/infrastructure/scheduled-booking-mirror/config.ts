/**
 * Flag and route configuration for the Scheduled booking mirror (Sc3). Read from the environment only.
 * The flag is off unless the value is exactly `true`. Errors name the variable and never echo a value.
 */
import type { EventRoute } from '../central-oidc/signed-events.ts';
import { MIN_SECRET_LENGTH } from '../central-oidc/signed-events.ts';
import { BOOKING_EVENT_TYPES } from './consumer.ts';

export const MIRROR_FLAG_ENV = 'SCHEDULED_BOOKING_MIRROR_ENABLED';
export const MIRROR_SECRET_ENV = 'SCHEDULED_BOOKING_EVENTS_SECRET';
export const MIRROR_ORG_ENV = 'SCHEDULED_BOOKING_ORGANISATION_ID';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ScheduledBookingConfigError extends Error {
  readonly code = 'scheduled_booking_config_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'ScheduledBookingConfigError';
  }
}

export function isMirrorEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[MIRROR_FLAG_ENV] === 'true';
}

/** Builds the route only when the flag is on. When it is off, returns null and reads nothing else. */
export function readMirrorRoute(env: Readonly<Record<string, string | undefined>> = process.env): EventRoute | null {
  if (!isMirrorEnabled(env)) return null;
  const secret = env[MIRROR_SECRET_ENV];
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new ScheduledBookingConfigError(`${MIRROR_SECRET_ENV} is missing or shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  const org = env[MIRROR_ORG_ENV]?.trim();
  if (!org || !UUID.test(org)) {
    throw new ScheduledBookingConfigError(`${MIRROR_ORG_ENV} must be a UUID`);
  }
  return {
    consumer: 'supercharged-scheduled-mirror',
    organisationId: org.toLowerCase(),
    eventTypes: [...BOOKING_EVENT_TYPES],
    keys: [{ id: 'current', secret, notBeforeMs: 0, notAfterMs: Number.MAX_SAFE_INTEGER }],
  };
}
