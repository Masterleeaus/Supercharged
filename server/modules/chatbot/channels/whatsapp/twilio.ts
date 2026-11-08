/**
 * Twilio request signing and WhatsApp address helpers.
 *
 * Twilio signs a webhook as follows: take the full callback URL, append every POST parameter sorted by name
 * (then by value), each as name followed by value with no separator, then HMAC-SHA1 with the auth token and
 * base64-encode the digest. The result arrives in the X-Twilio-Signature header.
 */
import { createHmac } from "node:crypto";

export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

/** Computes the signature Twilio would send for this URL and form parameters. */
export function computeTwilioSignature(authToken: string, url: string, entries: Array<[string, string]>): string {
  const sorted = [...entries].sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    if (aValue !== bValue) return aValue < bValue ? -1 : 1;
    return 0;
  });
  let data = url;
  for (const [key, value] of sorted) {
    data += key + value;
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/**
 * Accepts a WhatsApp address in any of the forms Twilio uses (whatsapp:+61..., +61..., or bare digits from WaId)
 * and returns E.164 with a leading plus. Returns null when the value is not a plausible number.
 */
export function normaliseWhatsappAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.trim().replace(/^whatsapp:/i, "").replace(/[\s()-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(stripped)) return stripped;
  if (/^[1-9]\d{6,14}$/.test(stripped)) return `+${stripped}`;
  return null;
}

/** Twilio account SIDs start with AC and carry 32 hex characters. The check also keeps the value out of the URL path unescaped. */
export function isTwilioAccountSid(value: unknown): value is string {
  return typeof value === "string" && /^AC[0-9a-fA-F]{32}$/.test(value);
}

/** Content template SIDs start with HX and carry 32 hex characters. */
export function isTwilioContentSid(value: unknown): value is string {
  return typeof value === "string" && /^HX[0-9a-fA-F]{32}$/.test(value);
}

/** Returns the URL when it is an absolute https URL with no credentials in it, else null. */
export function httpsWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return value;
  } catch {
    return null;
  }
}
