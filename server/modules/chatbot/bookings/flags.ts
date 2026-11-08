/**
 * Feature flag for the chatbot bookings slice. Default OFF. Desk reads flags from the environment
 * with an exact-match check (see server/integrations/titan-field/local-link-route.ts), and this follows
 * the same pattern: only the exact value "true" enables the feature (integration fix, rule L3).
 */
export const BOOKINGS_FLAG_ENV = "CHATBOT_BOOKINGS_ENABLED";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function isBookingsEnabled(env: EnvLike = process.env): boolean {
  return env[BOOKINGS_FLAG_ENV] === "true";
}
