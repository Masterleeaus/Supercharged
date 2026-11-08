/**
 * Drizzle implementation of ChannelAccountStorage. Every query filters on company_id.
 *
 * The build functions return un-executed query builders so tests can render them with PgDialect without a
 * database. The exported storage functions run them.
 */
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ChannelKind } from "../contracts/index.ts";
import type { StoredSealed } from "../secrets/sealed-form.ts";
import type { ChannelAccountStorage } from "./credentials.ts";
import { chatbotChannelAccounts } from "../db/channels-core.ts";

// Any Drizzle schema; the channel table is passed explicitly, so the database type stays loose.
export type ChannelDb = NodePgDatabase<Record<string, unknown>>;

export function buildFindSealedQuery(db: ChannelDb, companyId: string, kind: ChannelKind, accountId: string) {
  return db
    .select({ sealed: chatbotChannelAccounts.sealed })
    .from(chatbotChannelAccounts)
    .where(
      and(
        eq(chatbotChannelAccounts.companyId, companyId),
        eq(chatbotChannelAccounts.kind, kind),
        eq(chatbotChannelAccounts.accountId, accountId),
      ),
    )
    .limit(1);
}

/** Insert-or-replace keyed on (company_id, kind, account_id). The conflict target includes company_id. */
export function buildSaveSealedQuery(
  db: ChannelDb,
  companyId: string,
  kind: ChannelKind,
  accountId: string,
  sealed: string,
  now: Date,
) {
  return db
    .insert(chatbotChannelAccounts)
    .values({ companyId, kind, accountId, sealed, updatedAt: now })
    .onConflictDoUpdate({
      target: [chatbotChannelAccounts.companyId, chatbotChannelAccounts.kind, chatbotChannelAccounts.accountId],
      set: { sealed, updatedAt: now },
    });
}

export function createDrizzleChannelAccountStorage(db: ChannelDb, clock: () => Date = () => new Date()): ChannelAccountStorage {
  return {
    async findSealed(companyId, kind, accountId) {
      const rows = await buildFindSealedQuery(db, companyId, kind, accountId);
      const sealed = rows[0]?.sealed;
      return sealed === undefined ? null : (sealed as StoredSealed);
    },

    async saveSealed(companyId, kind, accountId, sealed) {
      await buildSaveSealedQuery(db, companyId, kind, accountId, sealed, clock());
    },
  };
}
