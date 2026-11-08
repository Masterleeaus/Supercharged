/**
 * Builds the public widget config. The output is an allowlist: only the keys of WidgetPublicConfig are copied,
 * field by field. A record that carries tokens or credentials cannot leak them, because they are never read.
 */
import type { WidgetPublicConfig } from "../contracts/index.ts";
import { normaliseTrustedDomains } from "./origin.ts";

export const DEFAULT_PRIMARY_COLOR = "#763ed1";

/** The keys a browser may receive. Kept in step with WidgetPublicConfig. */
export const WIDGET_PUBLIC_CONFIG_KEYS = [
  "publicId",
  "title",
  "welcomeMessage",
  "launcherText",
  "primaryColor",
  "launcherPosition",
  "language",
  "voiceEnabled",
  "generativeUiEnabled",
  "allowedOrigins",
  "assetBaseUrl",
] as const satisfies readonly (keyof WidgetPublicConfig)[];

/** Row shape the storage returns. Only these fields are read. Internal ids stay in the storage layer. */
export interface WidgetChatbotRecord {
  companyId: string;
  chatbotId: string;
  publicId: string;
  title: string;
  welcomeMessage: string;
  launcherText: string | null;
  primaryColor: string;
  launcherPosition: string;
  language: string;
  voiceEnabled: boolean;
  generativeUiEnabled: boolean;
  allowedOrigins: readonly string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const LANGUAGE_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;

export const isWidgetPublicId = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);

function clean(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // Remove control characters, keep the text readable.
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return text.length > 0 ? text.slice(0, max) : fallback;
}

/** Projects a storage record onto the public config. assetBaseUrl comes from server configuration, not the tenant. */
export function toWidgetPublicConfig(record: WidgetChatbotRecord, assetBaseUrl: string): WidgetPublicConfig {
  const launcherText = record.launcherText === null ? null : clean(record.launcherText, 120, "") || null;
  return {
    publicId: record.publicId,
    title: clean(record.title, 200, "Chat"),
    welcomeMessage: clean(record.welcomeMessage, 1000, ""),
    launcherText,
    primaryColor: COLOR_PATTERN.test(record.primaryColor) ? record.primaryColor.toLowerCase() : DEFAULT_PRIMARY_COLOR,
    launcherPosition: record.launcherPosition === "bottom-left" ? "bottom-left" : "bottom-right",
    language: LANGUAGE_PATTERN.test(record.language) ? record.language : "en",
    voiceEnabled: record.voiceEnabled === true,
    generativeUiEnabled: record.generativeUiEnabled === true,
    allowedOrigins: normaliseTrustedDomains([...record.allowedOrigins]),
    assetBaseUrl,
  };
}
