/**
 * Storage for Instagram accounts and OAuth states. Drizzle implementations plus in-memory twins for tests.
 * Every query filters on company_id. A row from another company reads as absent.
 */
import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { requireCompanyId } from "../../chatbot-scope.ts";
import type { InstagramAccountRecord, InstagramAccountStorage } from "./accounts.ts";
import type { StoredSealed } from "../../secrets/sealed-form.ts";
import { chatbotInstagramAccounts, chatbotInstagramOauthStates } from "../../db/channels-instagram.ts";
import type { OAuthStateStorage } from "./oauth.ts";

type Db = PgDatabase<any, any, any>;

function toRecord(row: typeof chatbotInstagramAccounts.$inferSelect): InstagramAccountRecord {
  return {
    companyId: row.companyId,
    id: row.id,
    pageId: row.pageId,
    username: row.username,
    sealedCredentials: row.sealedCredentials as StoredSealed,
    tokenExpiresAt: row.tokenExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleInstagramAccountStorage implements InstagramAccountStorage {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async upsert(companyId: string, record: InstagramAccountRecord): Promise<void> {
    requireCompanyId(companyId);
    if (record.companyId !== companyId) throw new Error("company mismatch");
    await this.db
      .insert(chatbotInstagramAccounts)
      .values({
        companyId,
        id: record.id,
        pageId: record.pageId,
        username: record.username,
        sealedCredentials: record.sealedCredentials,
        tokenExpiresAt: record.tokenExpiresAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [chatbotInstagramAccounts.companyId, chatbotInstagramAccounts.id],
        set: {
          pageId: record.pageId,
          username: record.username,
          sealedCredentials: record.sealedCredentials,
          tokenExpiresAt: record.tokenExpiresAt,
          updatedAt: record.updatedAt,
        },
        where: eq(chatbotInstagramAccounts.companyId, companyId),
      });
  }

  async get(companyId: string, accountId: string): Promise<InstagramAccountRecord | null> {
    requireCompanyId(companyId);
    const rows = await this.db
      .select()
      .from(chatbotInstagramAccounts)
      .where(and(eq(chatbotInstagramAccounts.companyId, companyId), eq(chatbotInstagramAccounts.id, accountId)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listExpiringBefore(companyId: string, cutoff: Date, limit: number): Promise<InstagramAccountRecord[]> {
    requireCompanyId(companyId);
    const rows = await this.db
      .select()
      .from(chatbotInstagramAccounts)
      .where(
        and(
          eq(chatbotInstagramAccounts.companyId, companyId),
          lte(chatbotInstagramAccounts.tokenExpiresAt, cutoff),
        ),
      )
      .orderBy(asc(chatbotInstagramAccounts.tokenExpiresAt))
      .limit(Math.max(0, limit));
    return rows.map(toRecord);
  }
}

export class DrizzleOauthStateStorage implements OAuthStateStorage {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async insert(companyId: string, stateHash: string, expiresAt: Date): Promise<boolean> {
    requireCompanyId(companyId);
    const rows = await this.db
      .insert(chatbotInstagramOauthStates)
      .values({ companyId, stateHash, expiresAt })
      .onConflictDoNothing()
      .returning({ stateHash: chatbotInstagramOauthStates.stateHash });
    return rows.length === 1;
  }

  async consume(companyId: string, stateHash: string, now: Date): Promise<boolean> {
    requireCompanyId(companyId);
    const rows = await this.db
      .delete(chatbotInstagramOauthStates)
      .where(
        and(
          eq(chatbotInstagramOauthStates.companyId, companyId),
          eq(chatbotInstagramOauthStates.stateHash, stateHash),
          gt(chatbotInstagramOauthStates.expiresAt, now),
        ),
      )
      .returning({ stateHash: chatbotInstagramOauthStates.stateHash });
    return rows.length === 1;
  }
}

/** In-memory OAuth state storage. consume() removes the entry, so a state works once. */
export function createMemoryOauthStateStorage(): OAuthStateStorage {
  const rows = new Map<string, { expiresAt: Date }>();
  const key = (companyId: string, hash: string) => `${companyId}\u0000${hash}`;
  return {
    async insert(companyId, stateHash, expiresAt) {
      requireCompanyId(companyId);
      if (rows.has(key(companyId, stateHash))) return false;
      rows.set(key(companyId, stateHash), { expiresAt });
      return true;
    },
    async consume(companyId, stateHash, now) {
      requireCompanyId(companyId);
      const k = key(companyId, stateHash);
      const row = rows.get(k);
      if (!row) return false;
      rows.delete(k);
      return row.expiresAt.getTime() > now.getTime();
    },
  };
}
