/**
 * Cal.com API key and webhook secret, stored through the SecretBox contract.
 *
 * The box is injected (contracts/secrets.ts). This folder does not own a SecretBox implementation, so nothing here
 * can fall back to plaintext: a missing or malformed CHATBOT_SECRET_KEY makes the box throw, and that error
 * reaches the caller. The company id is bound as associated data, so a sealed row copied to another company does
 * not open.
 *
 * Plaintext is returned only by read(), for one call. It is never listed, logged, or put in an error.
 */
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import type { CalendarCredentials, CalendarProviderKey, SecretBox } from "../contracts/index.ts";
import { openStored, sealToString } from "../secrets/sealed-form.ts";
import { CALCOM_API_KEY, CALCOM_WEBHOOK_SECRET } from "./calcom.ts";
import { CALENDAR_SECRET_PURPOSES, type CalendarSecretPurpose, type CalendarSecretStorage } from "./types.ts";

export interface CalendarSecretStore {
  /** Seals the value and stores it, replacing any earlier value for the same purpose. */
  save(companyId: string, provider: CalendarProviderKey, purpose: CalendarSecretPurpose, plaintext: string): Promise<void>;
  /** Opens the stored value for one call. Returns null when none is stored for this company. */
  read(companyId: string, provider: CalendarProviderKey, purpose: CalendarSecretPurpose): Promise<string | null>;
}

export interface CalendarSecretStoreDeps {
  box: SecretBox;
  storage: CalendarSecretStorage;
  now?: () => Date;
}

function requirePurpose(purpose: string): CalendarSecretPurpose {
  if (!(CALENDAR_SECRET_PURPOSES as readonly string[]).includes(purpose)) {
    throw new ChatbotError("unknown calendar secret purpose", 422);
  }
  return purpose as CalendarSecretPurpose;
}

export function createCalendarSecretStore(deps: CalendarSecretStoreDeps): CalendarSecretStore {
  const now = deps.now ?? (() => new Date());
  return {
    async save(companyId, provider, purpose, plaintext) {
      const scope = requireCompanyId(companyId);
      const kind = requirePurpose(purpose);
      if (typeof plaintext !== "string" || plaintext.trim().length === 0) {
        throw new ChatbotError("secret value is required", 422);
      }
      const sealed = await sealToString(deps.box, scope, plaintext);
      await deps.storage.put(scope, provider, kind, sealed, now());
    },

    async read(companyId, provider, purpose) {
      const scope = requireCompanyId(companyId);
      const kind = requirePurpose(purpose);
      const sealed = await deps.storage.get(scope, provider, kind);
      if (!sealed) return null;
      return openStored(deps.box, scope, sealed);
    },
  };
}

/**
 * Builds the Cal.com credentials for one call. The API key is required. The webhook secret is optional here, and
 * a missing one makes webhook verification fail closed (see calcom.ts). Returns null when no API key is stored.
 */
export async function loadCalcomCredentials(
  companyId: string,
  secrets: Pick<CalendarSecretStore, "read">,
): Promise<CalendarCredentials | null> {
  const scope = requireCompanyId(companyId);
  const apiKey = await secrets.read(scope, "calcom", "api_key");
  if (apiKey === null) return null;
  const credentials: Record<string, string> = { [CALCOM_API_KEY]: apiKey };
  const webhookSecret = await secrets.read(scope, "calcom", "webhook_secret");
  if (webhookSecret !== null) credentials[CALCOM_WEBHOOK_SECRET] = webhookSecret;
  return credentials;
}
