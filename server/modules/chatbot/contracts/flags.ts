/**
 * Feature flags. One reader, one rule: a flag is on only when its value is exactly the string "true".
 * Every flag defaults off. Values such as "1", "yes", "on" or "TRUE" are off.
 *
 * Existing slice flags (ENABLE_CHATBOT_BOOKING_ROUTES, ENABLE_CHATBOT_BUILDER_ROUTES, DESK_CHATBOT_AGENT_ROUTES,
 * CHATBOT_FULFILMENT_ENABLED, CHATBOT_NATIVE_ORDERS_ENABLED) already follow this rule. New contract flags go below.
 */

export type FlagEnv = Readonly<Record<string, string | undefined>>;

/** Returns true only when env[name] is exactly "true". Pure: reads the object passed in, nothing else. */
export function readFlag(name: string, env: FlagEnv): boolean {
  return env[name] === "true";
}

/** Signature of readFlag, for modules that receive the reader as a dependency. */
export type ReadFlag = (name: string, env: FlagEnv) => boolean;

/** Flags introduced by these contracts. Builders reference these names, never raw strings. */
export const CONTRACT_FLAGS = {
  /** Gemini model provider. Off by default. */
  GEMINI_ENABLED: "CHATBOT_GEMINI_ENABLED",
  /** Knowledge sources, embeddings and retrieval. */
  KNOWLEDGE_ENABLED: "CHATBOT_KNOWLEDGE_ENABLED",
  /** Voice: speech-to-text, text-to-speech and call sessions. */
  VOICE_ENABLED: "CHATBOT_VOICE_ENABLED",
  /** Public widget endpoints and embed tokens. */
  WIDGET_ENABLED: "CHATBOT_WIDGET_ENABLED",
  /** Payment provider calls (intents, capture, refund). */
  PAYMENTS_ENABLED: "CHATBOT_PAYMENTS_ENABLED",
  /** Buy-now-pay-later offers at checkout. */
  BNPL_ENABLED: "CHATBOT_BNPL_ENABLED",
  /** Marketplace write operations (listing changes). Read-only marketplace use does not need this. */
  MARKETPLACE_WRITE_ENABLED: "CHATBOT_MARKETPLACE_WRITE_ENABLED",
  /** Pricing rule evaluation at quote time. */
  PRICING_RULES_ENABLED: "CHATBOT_PRICING_RULES_ENABLED",
  /** Rental and hire receivables. */
  RENTAL_HIRE_ENABLED: "CHATBOT_RENTAL_HIRE_ENABLED",
  /** Calendly and Cal.com calendar providers. Native bookings do not need this. */
  EXTERNAL_CALENDARS_ENABLED: "CHATBOT_EXTERNAL_CALENDARS_ENABLED",
  /** Outbound customer webhooks from the outbox. */
  OUTBOUND_WEBHOOKS_ENABLED: "CHATBOT_OUTBOUND_WEBHOOKS_ENABLED",
  /** WhatsApp channel. Added by the channels change request 1. The value matches channels/whatsapp. */
  WHATSAPP_CHANNEL: "CHATBOT_WHATSAPP_CHANNEL_ENABLED",
  /** Instagram channel. Added by the Instagram change request. Off by default. */
  INSTAGRAM_ENABLED: "CHATBOT_INSTAGRAM_ENABLED",
  /** Review requests after a conversation. Added by the reviews change request. Off by default. */
  REVIEWS_ENABLED: "CHATBOT_REVIEWS_ENABLED",
  /**
   * Telegram channel kill switch. Off by default. wiring/mount.ts mounts the telegram route only when this is "true",
   * and the telegram router checks it again. It still needs CHATBOT_CHANNELS_ENABLED for the channel surface as a whole.
   */
  TELEGRAM_CHANNEL: "CHATBOT_TELEGRAM_CHANNEL_ENABLED",
  /** Conversation attachments (upload and read). Added by the ops change request. Off by default. */
  ATTACHMENTS_ENABLED: "CHATBOT_ATTACHMENTS_ENABLED",
  /** Analytics export (CSV). Added by the ops change request. Off by default. */
  ANALYTICS_EXPORT_ENABLED: "CHATBOT_ANALYTICS_EXPORT_ENABLED",
} as const;

export type ContractFlagName = (typeof CONTRACT_FLAGS)[keyof typeof CONTRACT_FLAGS];
