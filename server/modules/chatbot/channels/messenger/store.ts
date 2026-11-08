/**
 * Drizzle storage for Messenger accounts: encrypted credentials and the outbound send ledger.
 * Every query filters on company_id. A row from another company reads as absent.
 * Nothing here logs. Decrypted credentials are returned to the caller only.
 */
import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { ChannelCredentialSource, ChannelCredentials, SecretBox } from "../../contracts/index.ts";
import { openStored, sealToString } from "../../secrets/sealed-form.ts";
import { chatbotChannelAccounts, chatbotChannelSendKeys } from "../../db/channels-core.ts";
import type { SendLedger, LedgerClaim } from "./provider.ts";

export const MESSENGER_CHANNEL = "messenger" as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

/** Where clause for one account. Exported so the tests can render it. */
export function accountWhere(companyId: string, accountId: string) {
  return and(
    eq(chatbotChannelAccounts.companyId, companyId),
    eq(chatbotChannelAccounts.kind, MESSENGER_CHANNEL),
    eq(chatbotChannelAccounts.accountId, accountId),
  );
}

/** Where clause for one send key. Exported so the tests can render it. */
export function sendKeyWhere(companyId: string, accountId: string, key: string) {
  return and(
    eq(chatbotChannelSendKeys.companyId, companyId),
    eq(chatbotChannelSendKeys.channel, MESSENGER_CHANNEL),
    eq(chatbotChannelSendKeys.accountId, accountId),
    eq(chatbotChannelSendKeys.idempotencyKey, key),
  );
}

function parseCredentials(plaintext: string): ChannelCredentials {
  const value: unknown = JSON.parse(plaintext);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("messenger: stored credentials are malformed");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function createMessengerStore(db: Db, secretBox: SecretBox) {
  const credentials: ChannelCredentialSource = {
    async load(companyId, kind, accountId) {
      if (kind !== MESSENGER_CHANNEL) return null;
      const rows = await db
        .select({ sealed: chatbotChannelAccounts.sealed })
        .from(chatbotChannelAccounts)
        .where(accountWhere(companyId, accountId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const plaintext = await openStored(secretBox, companyId, row.sealed);
      return parseCredentials(plaintext);
    },
  };

  /** Seals the credentials with the company id bound. Upserts on (company_id, channel, account_id). */
  async function saveCredentials(companyId: string, accountId: string, values: ChannelCredentials): Promise<void> {
    const sealed = await sealToString(secretBox, companyId, JSON.stringify(values));
    await db
      .insert(chatbotChannelAccounts)
      .values({ companyId, kind: MESSENGER_CHANNEL, accountId, sealed })
      .onConflictDoUpdate({
        target: [chatbotChannelAccounts.companyId, chatbotChannelAccounts.kind, chatbotChannelAccounts.accountId],
        set: { sealed, updatedAt: new Date() },
      });
  }

  const ledger: SendLedger = {
    async claim(companyId, accountId, key): Promise<LedgerClaim> {
      const inserted = await db
        .insert(chatbotChannelSendKeys)
        .values({ companyId, channel: MESSENGER_CHANNEL, accountId, idempotencyKey: key, status: "pending" })
        .onConflictDoNothing()
        .returning({ id: chatbotChannelSendKeys.id });
      if (inserted.length > 0) return { kind: "claimed" };
      const rows = await db
        .select({ status: chatbotChannelSendKeys.status, externalMessageId: chatbotChannelSendKeys.externalMessageId })
        .from(chatbotChannelSendKeys)
        .where(sendKeyWhere(companyId, accountId, key))
        .limit(1);
      const row = rows[0];
      if (!row) return { kind: "claimed" };
      return { kind: "duplicate", done: row.status === "done", externalMessageId: row.externalMessageId ?? null };
    },
    async complete(companyId, accountId, key, externalMessageId) {
      await db
        .update(chatbotChannelSendKeys)
        .set({ status: "done", externalMessageId })
        .where(sendKeyWhere(companyId, accountId, key));
    },
    async release(companyId, accountId, key) {
      await db.delete(chatbotChannelSendKeys).where(sendKeyWhere(companyId, accountId, key));
    },
  };

  return { credentials, saveCredentials, ledger };
}
