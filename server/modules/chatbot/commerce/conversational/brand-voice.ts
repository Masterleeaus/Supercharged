/**
 * Brand voice profile: one per company and chatbot. Holds the tone, locale, and the preferred and forbidden
 * wording that listing intelligence applies (see toBrandGuide).
 *
 * Every read and write takes companyId. A profile saved for another company is treated as absent.
 * validateBrandVoice() is pure. It refuses bad input with a CommerceError whose fields name the field only,
 * never the submitted value.
 *
 * Storage port: see brand-voice-store.ts for the Drizzle implementation over brand-voice-schema.ts.
 */
import { CommerceError } from "./errors.ts";
import type { BrandGuide } from "./listing-intelligence.ts";

export const BRAND_VOICE_LIMITS = {
  nameMax: 120,
  toneMax: 500,
  localeMax: 35,
  termMax: 60,
  termsPerList: 100,
} as const;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

export interface BrandVoiceInput {
  name: string;
  tone: string;
  locale: string;
  preferredTerms: string[];
  forbiddenTerms: string[];
}

export interface BrandVoiceProfile extends BrandVoiceInput {
  companyId: string;
  chatbotId: string;
  updatedBy: string;
  updatedAt: Date;
}

export interface BrandVoiceStore {
  find(companyId: string, chatbotId: string): Promise<BrandVoiceProfile | null>;
  /** Insert or replace the row for (companyId, chatbotId). */
  upsert(profile: BrandVoiceProfile): Promise<void>;
  /** Returns true when a row for this company and chatbot was removed. */
  remove(companyId: string, chatbotId: string): Promise<boolean>;
}

export interface BrandVoiceDeps {
  store: BrandVoiceStore;
  now: () => Date;
}

export interface BrandVoiceService {
  get(companyId: string, chatbotId: string): Promise<BrandVoiceProfile | null>;
  save(companyId: string, chatbotId: string, input: unknown, actorId: string): Promise<BrandVoiceProfile>;
  remove(companyId: string, chatbotId: string): Promise<boolean>;
}

/** Checks and normalises an input. Pure. Throws a CommerceError (validation) on the first problem. */
export function validateBrandVoice(input: unknown): BrandVoiceInput {
  if (input === null || typeof input !== "object") {
    throw new CommerceError("validation", "The brand voice profile is required.", { profile: "required" });
  }
  const raw = input as Record<string, unknown>;

  const name = boundedText(raw.name, "name", BRAND_VOICE_LIMITS.nameMax, 1);
  const tone = boundedText(raw.tone ?? "", "tone", BRAND_VOICE_LIMITS.toneMax, 0);
  const locale = boundedText(raw.locale, "locale", BRAND_VOICE_LIMITS.localeMax, 1);
  if (!LOCALE.test(locale)) throw new CommerceError("validation", "The locale is not a valid language tag.", { locale: "invalid" });

  const preferredTerms = termList(raw.preferredTerms ?? [], "preferred_terms");
  const forbiddenTerms = termList(raw.forbiddenTerms ?? [], "forbidden_terms");

  const preferred = new Set(preferredTerms.map((t) => t.toLowerCase()));
  if (forbiddenTerms.some((t) => preferred.has(t.toLowerCase()))) {
    throw new CommerceError("validation", "A term cannot be both preferred and forbidden.", { terms: "conflict" });
  }

  return { name, tone, locale, preferredTerms, forbiddenTerms };
}

export function createBrandVoiceService(deps: BrandVoiceDeps): BrandVoiceService {
  return {
    async get(companyId, chatbotId) {
      requireId(companyId, "company_id");
      requireId(chatbotId, "chatbot_id");
      return deps.store.find(companyId.trim(), chatbotId.trim());
    },

    async save(companyId, chatbotId, input, actorId) {
      requireId(companyId, "company_id");
      requireId(chatbotId, "chatbot_id");
      requireId(actorId, "actor_id");
      const checked = validateBrandVoice(input);
      const profile: BrandVoiceProfile = {
        ...checked,
        companyId: companyId.trim(),
        chatbotId: chatbotId.trim(),
        updatedBy: actorId.trim(),
        updatedAt: deps.now(),
      };
      await deps.store.upsert(profile);
      return profile;
    },

    async remove(companyId, chatbotId) {
      requireId(companyId, "company_id");
      requireId(chatbotId, "chatbot_id");
      return deps.store.remove(companyId.trim(), chatbotId.trim());
    },
  };
}

/** Maps a saved profile to the guide listing intelligence reads. Pure. */
export function toBrandGuide(profile: Pick<BrandVoiceProfile, "forbiddenTerms" | "preferredTerms">): BrandGuide {
  return { forbiddenTerms: [...profile.forbiddenTerms], preferredTerms: [...profile.preferredTerms] };
}

function termList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new CommerceError("validation", `${field} must be a list.`, { [field]: "invalid" });
  if (value.length > BRAND_VOICE_LIMITS.termsPerList) {
    throw new CommerceError("validation", `${field} has too many terms.`, { [field]: "too_many" });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const term = boundedText(item, field, BRAND_VOICE_LIMITS.termMax, 1);
    const key = term.toLowerCase();
    if (seen.has(key)) throw new CommerceError("validation", `${field} has a duplicate term.`, { [field]: "duplicate" });
    seen.add(key);
    out.push(term);
  }
  return out;
}

function boundedText(value: unknown, field: string, max: number, min: number): string {
  if (typeof value !== "string") throw new CommerceError("validation", `${field} must be text.`, { [field]: "invalid" });
  const trimmed = value.trim();
  if (CONTROL_CHARS.test(trimmed)) throw new CommerceError("validation", `${field} contains control characters.`, { [field]: "invalid" });
  const length = [...trimmed].length;
  if (length < min) throw new CommerceError("validation", `${field} is required.`, { [field]: "required" });
  if (length > max) throw new CommerceError("validation", `${field} is too long.`, { [field]: "too_long" });
  return trimmed;
}

function requireId(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CommerceError("validation", `${field} is required.`, { [field]: "required" });
  }
}
