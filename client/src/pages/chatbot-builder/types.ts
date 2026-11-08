/**
 * Shared contract for the chatbot builder wizard. Step agents code against this file.
 *
 * Wire names are camelCase, the same style as the Desk chatbot record. The PHP field each one maps to is
 * listed next to it, and the full map is in server/modules/chatbot/builder-routes/endpoint-map.md.
 *
 * Each step owns one group of WizardState. A step reads its group from StepProps.value and writes changes
 * through StepProps.onChange. Steps never call the save endpoints directly; they call StepProps.saveNow.
 */
import type { ComponentType, LazyExoticComponent } from "react";

// ---------------------------------------------------------------------------
// Step ids and registry shape
// ---------------------------------------------------------------------------

/** Step ids, in wizard order. Same names and order as the core StepEnum. */
export type StepId = "configure" | "customize" | "train" | "embed" | "channel";

export interface StepDefinition {
  id: StepId;
  label: string;
  /** Wizard state group this step owns. Same value as id. */
  group: StepId;
  /** True when the step needs a service Desk does not have yet (see DECISIONS.md). */
  external: boolean;
  /** Set to false to hide the step from the wizard. Defaults to shown. */
  enabled?: boolean;
  /**
   * The step's component, loaded with React.lazy from ./steps/<id>.tsx. Typed loosely because each step
   * declares its own StepProps<G>; the shell passes the matching group.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: LazyExoticComponent<ComponentType<any>>;
}

// ---------------------------------------------------------------------------
// Enumerations (same values as the PHP enums in System/Enums)
// ---------------------------------------------------------------------------

/** BubbleDesign enum. Used by configure. */
export const BUBBLE_DESIGNS = ["blank", "plain", "links", "modern", "suggestions", "promo_banner"] as const;
export type BubbleDesign = (typeof BUBBLE_DESIGNS)[number];

/** HeaderBgEnum. Used by customize. */
export const HEADER_BG_TYPES = ["color", "gradient", "image"] as const;
export type HeaderBgType = (typeof HEADER_BG_TYPES)[number];

/** PositionEnum. Used by customize. */
export const CHATBOT_POSITIONS = ["left", "right"] as const;
export type ChatbotPosition = (typeof CHATBOT_POSITIONS)[number];

/** Language value meaning "detect from the visitor". Core default. */
export const LANGUAGE_AUTO = "auto";

/** Kinds accepted by POST /api/chatbot/builder/:id/uploads. Each one sets one customize or configure field. */
export const UPLOAD_KINDS = ["logo", "welcome_bg", "header_bg", "promo_banner"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

// ---------------------------------------------------------------------------
// Field groups
// ---------------------------------------------------------------------------

export interface SuggestedPrompt {
  /** Core: suggested_prompts.*.name */
  name: string;
  /** Core: suggested_prompts.*.prompt */
  prompt: string;
}

/**
 * Configure step (core: edit-step-configure.blade.php).
 * The first six fields are already in the Desk chatbot table (EXISTS). The rest need builder routes (NEW).
 */
export interface ConfigureState {
  /** EXISTS. Core: title. Required. */
  title: string;
  /** EXISTS. Core: language. "auto" or a locale code from SUPPORTED_LANGUAGES. */
  language: string;
  /** EXISTS. Core: welcome_message. Required on save (core parity). */
  welcomeMessage: string;
  /** EXISTS. Core: instructions. Required on save (core parity). */
  instructions: string;
  /** EXISTS. Core: active. Toggled from the chatbot list in core, not in the wizard. */
  active: boolean;

  /** NEW. Core: bubble_message. Required on save (core parity). */
  bubbleMessage: string;
  /** NEW. Core: bubble_design. */
  bubbleDesign: BubbleDesign;
  /** NEW. Core: promo_banner_image. Path returned by uploadBuilderImage(kind "promo_banner"). Null when unset. */
  promoBannerImage: string | null;
  /** NEW. Core: promo_banner_title. */
  promoBannerTitle: string;
  /** NEW. Core: promo_banner_description. */
  promoBannerDescription: string;
  /** NEW. Core: promo_banner_btn_label. */
  promoBannerButtonLabel: string;
  /** NEW. Core: promo_banner_btn_link. */
  promoBannerButtonLink: string;
  /** NEW. Core: do_not_go_beyond_instructions. */
  doNotGoBeyondInstructions: boolean;
  /** NEW. Core: suggested_prompts_enabled. */
  suggestedPromptsEnabled: boolean;
  /** NEW. Core: suggested_prompts (array of name and prompt). */
  suggestedPrompts: SuggestedPrompt[];
}

/**
 * Customize step (core: edit-step-customize.blade.php). All NEW.
 * Image fields hold a path returned by uploadBuilderImage, or null.
 */
export interface CustomizeState {
  /** NEW. Core: logo. */
  logo: string | null;
  /** NEW. Core: welcome_bg_image. */
  welcomeBgImage: string | null;
  /** NEW. Core: avatar. Preset path from listBuilderAvatars, or an uploaded avatar path. */
  avatar: string | null;
  /** NEW. Core: color. Hex value from the color picker or a preset. */
  color: string | null;
  /** NEW. Core: header_bg_type. */
  headerBgType: HeaderBgType;
  /** NEW. Core: header_bg_color. */
  headerBgColor: string | null;
  /** NEW. Core: header_bg_gradient. CSS linear-gradient or radial-gradient string. */
  headerBgGradient: string | null;
  /** NEW. Core: header_bg_image. */
  headerBgImage: string | null;
  /** NEW. Core: show_logo. */
  showLogo: boolean;
  /** NEW. Core: show_date_and_time. */
  showDateAndTime: boolean;
  /** NEW. Core: is_emoji ("Enable Emoji"). */
  isEmoji: boolean;
  /** NEW. Core: is_links ("Links In Welcome Screen"). */
  isLinks: boolean;
  /** NEW. Core: show_social_links_in_first_message. */
  showSocialLinksInFirstMessage: boolean;
  /** NEW. Core: is_email_collect. */
  isEmailCollect: boolean;
  /** NEW. Core: is_contact ("Contact Us"). */
  isContact: boolean;
  /** NEW. Core: is_articles ("Help Center"). The core input wrongly carries name="is_contact"; see DECISIONS.md. */
  isArticles: boolean;
  /** NEW. Core: is_gdpr ("Show GDPR"). */
  isGdpr: boolean;
  /** NEW. Core: trigger_background. Core stores the string "transparent" or ""; the wire value is a boolean. */
  transparentTrigger: boolean;
  /** NEW. Core: trigger_avatar_size. Pixel value as a string, for example "60px". Range 20 to 100. */
  triggerAvatarSize: string;
  /** NEW. Core: position. */
  position: ChatbotPosition;
  /** NEW. Core: footer_link. */
  footerLink: string | null;
  /** NEW. Core: whatsapp_link. */
  whatsappLink: string | null;
  /** NEW. Core: telegram_link. */
  telegramLink: string | null;
  /** NEW. Core: facebook_link. */
  facebookLink: string | null;
  /** NEW. Core: instagram_link. */
  instagramLink: string | null;
  /** NEW. Core: watch_product_tour_link. */
  watchProductTourLink: string | null;
  /** NEW. Core: privacy_policy_link. */
  privacyPolicyLink: string | null;
  /** NEW. Core: terms_of_service_link. */
  termsOfServiceLink: string | null;
}

/**
 * Train step (core: edit-step-train.blade.php). Empty for this round: every train action needs a training
 * provider or an embeddings store that Desk does not have (EXTERNAL). Kept so the group exists in WizardState.
 */
export type TrainState = Record<never, never>;

/**
 * Embed step (core: edit-step-embed.blade.php).
 * The iframe width and height sliders are not stored by core. Keep them in the step's own state, not here.
 */
export interface EmbedState {
  /** NEW. Core: trusted_domains. Hostnames without protocol or trailing slash. The backend normalises them. */
  trustedDomains: string[];
  /** NEW, read-only. Core: uuid. The public id used in the embed snippet. Set by the backend. Never sent in a patch. */
  uuid: string | null;
}

/** Channel step (core: edit-step-channel.blade.php). EXTERNAL and disabled this round. Empty for now. */
export type ChannelState = Record<never, never>;

export interface WizardState {
  configure: ConfigureState;
  customize: CustomizeState;
  train: TrainState;
  embed: EmbedState;
  channel: ChannelState;
}

// ---------------------------------------------------------------------------
// Props every step receives
// ---------------------------------------------------------------------------

export interface StepProps<G extends StepId = StepId> {
  /** Id of the step being rendered. */
  step: G;
  /** The step's own group from WizardState. */
  value: WizardState[G];
  /** Merges a partial change into the step's group. Does not save. */
  onChange: (patch: Partial<WizardState[G]>) => void;
  /**
   * Saved chatbot id. Null only on the configure step before the first save. Uploads and any other call that
   * needs a saved chatbot must be disabled while this is null.
   */
  chatbotId: string | null;
  /** True while a save is running. Disable inputs and buttons. */
  disabled: boolean;
  /**
   * Saves every changed group. Resolves true when the save worked, false when it failed (the shell shows the
   * error). On the configure step with no chatbot yet, this creates the chatbot.
   */
  saveNow: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Starting values for a new chatbot. These are wizard defaults, not the database defaults. Values loaded from
 * the server replace them. The core defaults were not verified against the core database.
 */
export const EMPTY_WIZARD_STATE: WizardState = {
  configure: {
    title: "",
    language: LANGUAGE_AUTO,
    welcomeMessage: "",
    instructions: "",
    active: true,
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
  },
  customize: {
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
  },
  train: {},
  embed: {
    trustedDomains: [],
    uuid: null,
  },
  channel: {},
};

/** Upper limits used by the wizard and mirrored by the backend builder routes. */
export const BUILDER_LIMITS = {
  title: 200,
  language: 10,
  bubbleMessage: 200,
  welcomeMessage: 2000,
  instructions: 20000,
  promoBannerTitle: 255,
  promoBannerDescription: 1000,
  promoBannerButtonLabel: 100,
  suggestedPrompts: 20,
  suggestedPromptName: 100,
  suggestedPromptText: 1000,
  trustedDomains: 50,
  /** Upload size in bytes. Core avatar limit is 4096 KB. */
  uploadBytes: 4 * 1024 * 1024,
} as const;
