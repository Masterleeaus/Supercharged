/**
 * Public widget contract: the config a browser may read, and the embed token that proves a visitor's session.
 *
 * Hard rule: nothing in WidgetPublicConfig or EmbedTokenClaims is a secret. The browser sees both.
 * No API keys, webhook secrets, signing keys, internal ids beyond publicId, or company-internal settings belong here.
 * Flag: CHATBOT_WIDGET_ENABLED.
 */

/** Public widget config. Served by GET on the public widget route. Safe to cache per chatbot. */
export interface WidgetPublicConfig {
  /** Public id of the chatbot. Not the internal primary key. */
  publicId: string;
  title: string;
  welcomeMessage: string;
  launcherText: string | null;
  primaryColor: string;
  launcherPosition: "bottom-left" | "bottom-right";
  language: string;
  voiceEnabled: boolean;
  generativeUiEnabled: boolean;
  /** Origins allowed to embed the widget. Checked by the server on every request too. */
  allowedOrigins: string[];
  /** Base URL the widget script loads its assets from. Set by configuration, not by the tenant. */
  assetBaseUrl: string;
}

/** Claims carried by an embed token. The token is a signed string; the signature is not part of these claims. */
export interface EmbedTokenClaims {
  /** Token format version. */
  v: 1;
  companyId: string;
  chatbotPublicId: string;
  /** Anonymous visitor id, random, created by the widget. Not a customer id. */
  visitorId: string;
  /** The origin the token was issued to. Checked against the request's Origin header. */
  origin: string;
  scope: ("chat" | "history" | "voice")[];
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds. Short-lived. */
  expiresAt: number;
}

export interface EmbedTokenIssuer {
  /** Signs claims with a per-company key from SecretBox. The returned string is what the widget stores. */
  issue(claims: Omit<EmbedTokenClaims, "v" | "issuedAt" | "expiresAt">, ttlSeconds: number): Promise<string>;
}

export type EmbedTokenVerification =
  | { ok: true; claims: EmbedTokenClaims }
  | { ok: false; reason: "malformed" | "signature_invalid" | "expired" | "origin_mismatch" | "scope_denied" };

export interface EmbedTokenVerifier {
  verify(token: string, requestOrigin: string, requiredScope: EmbedTokenClaims["scope"][number], nowSeconds: number): Promise<EmbedTokenVerification>;
}
