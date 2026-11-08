/**
 * Input schemas and wire mapping for the builder routes.
 *
 * The limits, enums and wizard defaults mirror client/src/pages/chatbot-builder/types.ts (BUILDER_LIMITS,
 * BUBBLE_DESIGNS, HEADER_BG_TYPES, CHATBOT_POSITIONS, UPLOAD_KINDS, EMPTY_WIZARD_STATE). If one side changes,
 * change the other. Rules are from endpoint-map.md section 4.
 *
 * Every object is .strict(), so a companyId anywhere in a body is rejected with 400, never dropped.
 * Tenancy is applied by the router, not here.
 */
import { z } from "zod";

export const BUILDER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const builderIdParam = z.string().regex(BUILDER_ID_PATTERN);

/** Mirrors BUILDER_LIMITS in the client types. */
export const BUILDER_LIMITS = {
  title: 200,
  language: 10,
  bubbleMessage: 200,
  welcomeMessage: 2000,
  instructions: 20000,
  promoBannerTitle: 255,
  promoBannerDescription: 1000,
  promoBannerButtonLabel: 100,
  promoBannerButtonLink: 2048,
  suggestedPrompts: 20,
  suggestedPromptName: 100,
  suggestedPromptText: 1000,
  trustedDomains: 50,
  uploadBytes: 4 * 1024 * 1024,
} as const;

export const BUBBLE_DESIGNS = ["blank", "plain", "links", "modern", "suggestions", "promo_banner"] as const;
export const HEADER_BG_TYPES = ["color", "gradient", "image"] as const;
export const CHATBOT_POSITIONS = ["left", "right"] as const;
export const UPLOAD_KINDS = ["logo", "welcome_bg", "header_bg", "promo_banner"] as const;

/** Classic columns that already exist on the chatbot row. Everything else goes into the settings JSON. */
export const CLASSIC_KEYS = ["title", "language", "welcomeMessage", "instructions", "active"] as const;

/** Configure keys that are stored in the settings JSON (the classic five are excluded). */
export const CONFIGURE_SETTING_KEYS = [
  "bubbleMessage",
  "bubbleDesign",
  "promoBannerImage",
  "promoBannerTitle",
  "promoBannerDescription",
  "promoBannerButtonLabel",
  "promoBannerButtonLink",
  "doNotGoBeyondInstructions",
  "suggestedPromptsEnabled",
  "suggestedPrompts",
] as const;

export const CUSTOMIZE_KEYS = [
  "logo",
  "welcomeBgImage",
  "avatar",
  "color",
  "headerBgType",
  "headerBgColor",
  "headerBgGradient",
  "headerBgImage",
  "showLogo",
  "showDateAndTime",
  "isEmoji",
  "isLinks",
  "showSocialLinksInFirstMessage",
  "isEmailCollect",
  "isContact",
  "isArticles",
  "isGdpr",
  "transparentTrigger",
  "triggerAvatarSize",
  "position",
  "footerLink",
  "whatsappLink",
  "telegramLink",
  "facebookLink",
  "instagramLink",
  "watchProductTourLink",
  "privacyPolicyLink",
  "termsOfServiceLink",
] as const;

/** Wizard defaults for keys never saved. Mirrors EMPTY_WIZARD_STATE in the client types. */
export const SETTING_DEFAULTS: Readonly<Record<string, unknown>> = {
  bubbleMessage: "",
  bubbleDesign: "blank",
  promoBannerImage: null,
  promoBannerTitle: "",
  promoBannerDescription: "",
  promoBannerButtonLabel: "",
  promoBannerButtonLink: "",
  doNotGoBeyondInstructions: false,
  suggestedPromptsEnabled: false,
  suggestedPrompts: [],
  logo: null,
  welcomeBgImage: null,
  avatar: null,
  color: null,
  headerBgType: "color",
  headerBgColor: null,
  headerBgGradient: null,
  headerBgImage: null,
  showLogo: true,
  showDateAndTime: false,
  isEmoji: false,
  isLinks: false,
  showSocialLinksInFirstMessage: false,
  isEmailCollect: false,
  isContact: false,
  isArticles: false,
  isGdpr: false,
  transparentTrigger: false,
  triggerAvatarSize: "60px",
  position: "right",
  footerLink: null,
  whatsappLink: null,
  telegramLink: null,
  facebookLink: null,
  instagramLink: null,
  watchProductTourLink: null,
  privacyPolicyLink: null,
  termsOfServiceLink: null,
  trustedDomains: [],
};

/** Path rules: an upload file name is one segment, starts with a letter or digit, and has no slash or dots run. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9]{1,8})?$/;
/** CSS characters that have no place in a gradient value (it is written into a style attribute). */
const UNSAFE_CSS = /[<>{};"'`\\]/;
const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const httpUrl = z
  .string()
  .trim()
  .max(BUILDER_LIMITS.promoBannerButtonLink)
  .refine(isHttpUrl, { message: "must be an http or https URL" });

/** Link fields: null, empty, or an http(s) URL. */
const optionalLink = z.union([z.null(), z.literal(""), httpUrl]);

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, { message: "must be a 6-digit hex colour" });

/** Image field: null, or a path under this company's chatbot upload folder. */
export function chatbotImagePath(companyId: string) {
  const prefix = `/uploads/chatbot/${companyId}/`;
  return z
    .string()
    .max(512)
    .nullable()
    .refine(
      (value) => value === null || (value.startsWith(prefix) && SAFE_FILE_NAME.test(value.slice(prefix.length))),
      { message: "must be an upload path owned by this company" },
    );
}

/** Avatar field: null, or a path. The router then checks it is a preset or this company's upload. */
const avatarPath = z.string().max(512).nullable();

const gradient = z
  .string()
  .max(500)
  .refine((value) => /^(linear|radial)-gradient\(/.test(value) && !UNSAFE_CSS.test(value), {
    message: "must be a linear-gradient() or radial-gradient() value",
  })
  .nullable();

const triggerAvatarSize = z
  .string()
  .regex(/^\d{2,3}px$/, { message: "must be a pixel value such as 60px" })
  .refine(
    (value) => {
      const px = Number.parseInt(value, 10);
      return px >= 20 && px <= 100;
    },
    { message: "must be between 20px and 100px" },
  );

/** Lower-cases, strips a protocol and trailing slashes, then checks the hostname and optional port. */
export function normaliseTrustedDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!HOST_PATTERN.test(value)) return null;
  const port = value.split(":")[1];
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) return null;
  }
  return value;
}

const trustedDomains = z
  .array(z.string().max(300))
  .max(BUILDER_LIMITS.trustedDomains)
  .transform((list, ctx) => {
    const out: string[] = [];
    list.forEach((raw, index) => {
      const host = normaliseTrustedDomain(raw);
      if (host === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must be a hostname, optionally with a port",
          path: [index],
        });
      } else if (!out.includes(host)) {
        out.push(host);
      }
    });
    return out;
  });

const suggestedPrompt = z
  .object({
    name: z.string().trim().min(1).max(BUILDER_LIMITS.suggestedPromptName),
    prompt: z.string().trim().min(1).max(BUILDER_LIMITS.suggestedPromptText),
  })
  .strict();

export function builderPatchSchema(companyId: string) {
  const configure = z
    .object({
      title: z.string().trim().min(1).max(BUILDER_LIMITS.title),
      language: z.string().min(2).max(BUILDER_LIMITS.language),
      welcomeMessage: z.string().max(BUILDER_LIMITS.welcomeMessage),
      instructions: z.string().max(BUILDER_LIMITS.instructions),
      active: z.boolean(),
      bubbleMessage: z.string().max(BUILDER_LIMITS.bubbleMessage),
      bubbleDesign: z.enum(BUBBLE_DESIGNS),
      promoBannerImage: chatbotImagePath(companyId),
      promoBannerTitle: z.string().max(BUILDER_LIMITS.promoBannerTitle),
      promoBannerDescription: z.string().max(BUILDER_LIMITS.promoBannerDescription),
      promoBannerButtonLabel: z.string().max(BUILDER_LIMITS.promoBannerButtonLabel),
      promoBannerButtonLink: z.union([z.literal(""), httpUrl]),
      doNotGoBeyondInstructions: z.boolean(),
      suggestedPromptsEnabled: z.boolean(),
      suggestedPrompts: z.array(suggestedPrompt).max(BUILDER_LIMITS.suggestedPrompts),
    })
    .partial()
    .strict();

  const customize = z
    .object({
      logo: chatbotImagePath(companyId),
      welcomeBgImage: chatbotImagePath(companyId),
      avatar: avatarPath,
      color: hexColor.nullable(),
      headerBgType: z.enum(HEADER_BG_TYPES),
      headerBgColor: hexColor.nullable(),
      headerBgGradient: gradient,
      headerBgImage: chatbotImagePath(companyId),
      showLogo: z.boolean(),
      showDateAndTime: z.boolean(),
      isEmoji: z.boolean(),
      isLinks: z.boolean(),
      showSocialLinksInFirstMessage: z.boolean(),
      isEmailCollect: z.boolean(),
      isContact: z.boolean(),
      isArticles: z.boolean(),
      isGdpr: z.boolean(),
      transparentTrigger: z.boolean(),
      triggerAvatarSize,
      position: z.enum(CHATBOT_POSITIONS),
      footerLink: optionalLink,
      whatsappLink: optionalLink,
      telegramLink: optionalLink,
      facebookLink: optionalLink,
      instagramLink: optionalLink,
      watchProductTourLink: optionalLink,
      privacyPolicyLink: optionalLink,
      termsOfServiceLink: optionalLink,
    })
    .partial()
    .strict();

  // embed.uuid is read-only: it is not in this object, so sending it fails the strict check.
  const embed = z.object({ trustedDomains }).partial().strict();

  return z
    .object({ configure, customize, embed })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, { message: "at least one group is required" });
}

export type BuilderPatchBody = z.infer<ReturnType<typeof builderPatchSchema>>;

/** Splits a validated patch into classic chatbot columns and the settings JSON. Only defined keys pass. */
export function splitPatch(body: BuilderPatchBody): {
  chatbot: Partial<Record<(typeof CLASSIC_KEYS)[number], unknown>>;
  settings: Record<string, unknown>;
} {
  const chatbot: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};
  const classic = new Set<string>(CLASSIC_KEYS);

  for (const [key, value] of Object.entries(body.configure ?? {})) {
    if (value === undefined) continue;
    if (classic.has(key)) chatbot[key] = value;
    else settings[key] = value;
  }
  for (const [key, value] of Object.entries(body.customize ?? {})) {
    if (value !== undefined) settings[key] = value;
  }
  if (body.embed?.trustedDomains !== undefined) settings.trustedDomains = body.embed.trustedDomains;

  return { chatbot: chatbot as Partial<Record<(typeof CLASSIC_KEYS)[number], unknown>>, settings };
}

/** One validation issue, shaped like a zod issue so the router can return both the same way. */
export interface SaveIssue {
  code: "custom";
  path: string[];
  message: string;
}

/**
 * Fields a save must leave filled in, as the PHP requires them (ChatbotStoreRequest and ChatbotUpdateRequest):
 * welcome message, bubble message, and instructions outside demo mode. PHP's "required" rejects blank and
 * whitespace-only text, so blank is checked the same way here.
 *
 * The check runs on the state a save would leave behind: the stored value, replaced by any value in the patch.
 * The request shape stays partial. A patch that leaves a stored field alone is still checked against that
 * stored value.
 */
export function saveIssues(
  stored: { welcomeMessage: string | null; instructions: string | null; settings: Record<string, unknown> },
  body: BuilderPatchBody,
  options: { demoMode: boolean },
): SaveIssue[] {
  const configure = body.configure ?? {};
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const isBlank = (value: string) => value.trim() === "";

  const welcome = configure.welcomeMessage ?? stored.welcomeMessage ?? "";
  const instructions = configure.instructions ?? stored.instructions ?? "";
  const bubble = configure.bubbleMessage ?? text(stored.settings.bubbleMessage);

  const issues: SaveIssue[] = [];
  const requireField = (field: string, value: string) => {
    if (isBlank(value)) {
      issues.push({ code: "custom", path: ["configure", field], message: "required on save" });
    }
  };
  requireField("welcomeMessage", welcome);
  requireField("bubbleMessage", bubble);
  if (!options.demoMode) requireField("instructions", instructions);
  return issues;
}

/** Wire shape of GET and PATCH /api/chatbot/builder/:id (BuilderSnapshot in the client types). */
export interface BuilderSnapshotBody {
  id: string;
  updatedAt: string;
  state: {
    configure: Record<string, unknown>;
    customize: Record<string, unknown>;
    train: Record<string, never>;
    embed: { trustedDomains: string[]; uuid: string };
    channel: Record<string, never>;
  };
}

export function toBuilderSnapshot(
  state: {
    chatbot: { id: string; title: string; language: string; welcomeMessage: string | null; instructions: string | null; active: boolean; updatedAt: Date };
    settings: Record<string, unknown>;
    publicUuid: string;
  },
): BuilderSnapshotBody {
  const read = (key: string) => (key in state.settings ? state.settings[key] : SETTING_DEFAULTS[key]);
  const pick = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, read(key)]));
  const { chatbot } = state;

  return {
    id: chatbot.id,
    updatedAt: chatbot.updatedAt.toISOString(),
    state: {
      configure: {
        title: chatbot.title,
        language: chatbot.language,
        welcomeMessage: chatbot.welcomeMessage ?? "",
        instructions: chatbot.instructions ?? "",
        active: chatbot.active,
        ...pick(CONFIGURE_SETTING_KEYS),
      },
      customize: pick(CUSTOMIZE_KEYS),
      train: {},
      embed: { trustedDomains: read("trustedDomains") as string[], uuid: state.publicUuid },
      channel: {},
    },
  };
}
