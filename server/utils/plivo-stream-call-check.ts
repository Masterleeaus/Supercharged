/**
 * Call check for Plivo WebSocket stream upgrades.
 *
 * The Twilio stream route rejects an upgrade when its call ID has no row in the
 * database (see server/engines/twilio-openai/routes/twilio-openai-stream.ts).
 * The Plivo routes use the same rule. The lookup is passed in so this module
 * does not import the database, which keeps it testable without infrastructure.
 *
 * Fails closed: an empty ID, a missing row, or a thrown lookup error all reject.
 */

export type PlivoStreamCallLookup = (callUuid: string) => Promise<{ id: string } | null | undefined>;

export async function isKnownPlivoStreamCall(
  callUuid: string,
  lookup: PlivoStreamCallLookup,
): Promise<boolean> {
  if (!callUuid) return false;
  try {
    const row = await lookup(callUuid);
    return Boolean(row && row.id);
  } catch {
    return false;
  }
}
