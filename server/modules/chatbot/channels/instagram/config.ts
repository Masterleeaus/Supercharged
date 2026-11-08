/**
 * Fixed Instagram (Meta Graph) settings. Nothing here is a secret. App id, app secret and verify token come
 * from the caller per company, never from this file.
 */

export const INSTAGRAM_GRAPH_HOST = "https://graph.facebook.com";
export const INSTAGRAM_DIALOG_HOST = "https://www.facebook.com";
export const INSTAGRAM_API_VERSION = "v18.0";

/** Hard limit per outbound call, in milliseconds. Every HttpClient call uses this or a smaller value. */
export const INSTAGRAM_HTTP_TIMEOUT_MS = 10_000;

/** Instagram direct messages are capped at 1000 characters. Longer text is refused, not truncated. */
export const INSTAGRAM_TEXT_MAX_LENGTH = 1000;

/** Meta allows a free-form reply for 24 hours after the customer's last message. */
export const INSTAGRAM_SESSION_WINDOW_HOURS = 24;

/** A pending OAuth state is valid for this long, then it can no longer be consumed. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Permissions requested at sign-in. The PHP extension also asked for publishing, insights and business
 * management scopes. The chatbot only reads account details and exchanges direct messages, so those are dropped.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_manage_messages",
  "pages_show_list",
  "pages_read_engagement",
] as const;

export const INSTAGRAM_CHANNEL_KIND = "instagram" as const;
