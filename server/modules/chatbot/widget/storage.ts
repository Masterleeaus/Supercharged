/**
 * Drizzle storage for the public widget. Implements the chatbot reader, the trusted-domain source and the
 * signing-key source used by the handlers and the embed token code.
 *
 * Tenancy: every query except selectChatbotByPublicIdQuery filters on company_id. The public-id lookup is the one
 * place a tenant is resolved from a request. It is safe because public_id is a random UUID, and the company it
 * returns is then used for every later call. See DECISIONS.md.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { SecretBox } from "../contracts/index.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import { openStored, sealToString } from "../secrets/sealed-form.ts";
import { widgetChatbotConfigs, widgetEmbedKeys } from "../db/widget.ts";
import type { WidgetChatbotRecord } from "./config.ts";
import type { EmbedKeySource, EmbedTrustSource } from "./embed-token.ts";
import type { WidgetChatbotReader } from "./handlers.ts";
import { normaliseTrustedDomains } from "./origin.ts";

// Any Drizzle Postgres database (node-postgres, pool or client). Typed loosely so tests can pass a recording client.
export type WidgetDb = PgDatabase<any, any, any>;

/** Public lookup by embed id. Not scoped by company, by design (see the header). */
export function selectChatbotByPublicIdQuery(db: WidgetDb, publicId: string) {
  return db
    .select()
    .from(widgetChatbotConfigs)
    .where(eq(widgetChatbotConfigs.publicId, publicId))
    .limit(1);
}

export function selectTrustedDomainsQuery(db: WidgetDb, companyId: string, publicId: string) {
  return db
    .select({ allowedOrigins: widgetChatbotConfigs.allowedOrigins })
    .from(widgetChatbotConfigs)
    .where(and(eq(widgetChatbotConfigs.companyId, companyId), eq(widgetChatbotConfigs.publicId, publicId)))
    .limit(1);
}

/** The newest key that has not been revoked. */
export function selectActiveSigningKeyQuery(db: WidgetDb, companyId: string) {
  return db
    .select({ sealed: widgetEmbedKeys.sealed })
    .from(widgetEmbedKeys)
    .where(and(eq(widgetEmbedKeys.companyId, companyId), isNull(widgetEmbedKeys.revokedAt)))
    .orderBy(desc(widgetEmbedKeys.createdAt))
    .limit(1);
}

/**
 * The write form for an embed signing key. Always the versioned string, sealed under the company id.
 * Any writer of widget_embed_keys.sealed must use this, not the contract object.
 */
export function sealSigningKeyForStorage(box: SecretBox, companyId: string, signingKey: string): Promise<string> {
  return sealToString(box, requireCompanyId(companyId), signingKey);
}

export class DrizzleWidgetStorage implements WidgetChatbotReader, EmbedTrustSource, EmbedKeySource {
  readonly db: WidgetDb;
  readonly secretBox: SecretBox;

  constructor(db: WidgetDb, secretBox: SecretBox) {
    this.db = db;
    this.secretBox = secretBox;
  }

  async findByPublicId(publicId: string): Promise<WidgetChatbotRecord | null> {
    const rows = (await selectChatbotByPublicIdQuery(this.db, publicId)) as Array<typeof widgetChatbotConfigs.$inferSelect>;
    const row = rows[0];
    if (!row) return null;
    return {
      companyId: row.companyId,
      chatbotId: row.chatbotId,
      publicId: row.publicId,
      title: row.title,
      welcomeMessage: row.welcomeMessage,
      launcherText: row.launcherText,
      primaryColor: row.primaryColor,
      launcherPosition: row.launcherPosition,
      language: row.language,
      voiceEnabled: row.voiceEnabled,
      generativeUiEnabled: row.generativeUiEnabled,
      allowedOrigins: normaliseTrustedDomains(row.allowedOrigins),
    };
  }

  async trustedDomainsFor(companyId: string, chatbotPublicId: string): Promise<readonly string[] | null> {
    const scope = requireCompanyId(companyId);
    const rows = (await selectTrustedDomainsQuery(this.db, scope, chatbotPublicId)) as Array<{ allowedOrigins: unknown }>;
    const row = rows[0];
    return row ? normaliseTrustedDomains(row.allowedOrigins) : null;
  }

  async signingKeyFor(companyId: string): Promise<string | null> {
    const scope = requireCompanyId(companyId);
    const rows = (await selectActiveSigningKeyQuery(this.db, scope)) as Array<{ sealed: unknown }>;
    const row = rows[0];
    if (!row) return null;
    try {
      // The key is returned to the token code only. A decrypt failure (wrong company, bad key) fails closed.
      // The row holds the versioned string, or the older contract object; openStored accepts both.
      return await openStored(this.secretBox, scope, row.sealed);
    } catch {
      return null;
    }
  }
}
