/**
 * Drizzle tables for the Instagram channel: connected accounts (credentials sealed with SecretBox) and pending
 * OAuth states. Moved here from channels/instagram/db.ts. Not applied by any migration.
 *
 * Every table has company_id. Primary keys are (company_id, id) so an upsert cannot overwrite another tenant's row.
 */
import { index, jsonb, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const INSTAGRAM_CONSTRAINTS = {
  accountsPk: "chatbot_instagram_accounts_pk",
  oauthStatesPk: "chatbot_instagram_oauth_states_pk",
} as const;

export const chatbotInstagramAccounts = pgTable(
  "chatbot_instagram_accounts",
  {
    companyId: uuid("company_id").notNull(),
    /** The Instagram business account id. */
    id: varchar("id", { length: 191 }).notNull(),
    pageId: varchar("page_id", { length: 191 }).notNull(),
    username: varchar("username", { length: 191 }),
    /** SealedSecret JSON. The plaintext holds the access token and the app secret. Never returned to a browser. */
    sealedCredentials: jsonb("sealed_credentials").notNull(),
    tokenExpiresAt: timestamp("token_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: INSTAGRAM_CONSTRAINTS.accountsPk, columns: [table.companyId, table.id] }),
    index("chatbot_instagram_accounts_company_expiry_idx").on(table.companyId, table.tokenExpiresAt),
  ],
);

export const chatbotInstagramOauthStates = pgTable(
  "chatbot_instagram_oauth_states",
  {
    companyId: uuid("company_id").notNull(),
    /** SHA-256 hex of the state value. The raw state is only in the redirect URL. */
    stateHash: varchar("state_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: INSTAGRAM_CONSTRAINTS.oauthStatesPk, columns: [table.companyId, table.stateHash] }),
    index("chatbot_instagram_oauth_states_company_expiry_idx").on(table.companyId, table.expiresAt),
  ],
);
