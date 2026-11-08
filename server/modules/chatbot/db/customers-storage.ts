/**
 * Drizzle implementation of CustomerStorage (see ../customers/customer-storage.ts).
 *
 * DRAFT. Not wired to a live database. Tests render the queries without connecting (see
 * tests/modules/chatbot-customers-drizzle.test.mjs).
 *
 * Every statement filters by company_id, and every method takes companyId first and calls requireCompanyId.
 * Inserts carry company_id in the column list. Merge and tag deletion run inside a transaction.
 * The optional onQuery hook receives each query builder before it runs. It exists for tests only.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { requireCompanyId } from "../chatbot-scope.ts";
import {
  definedOnly,
  emptyCustomerFields,
  type ContactIdentityRecord,
  type ContactIdentityUpsert,
  type CustomerInsert,
  type CustomerPatch,
  type CustomerRecord,
  type CustomerStorage,
  type MergeResult,
  type TagInsert,
  type TagPatch,
  type TagRecord,
} from "../customers/customer-storage.ts";
import {
  chatbotContactIdentities,
  chatbotConversationCustomerTags,
  chatbotCustomerConversations,
  chatbotCustomers,
  chatbotCustomerTags,
  type ChatbotContactIdentityRow,
  type ChatbotCustomerRow,
  type ChatbotCustomerTagRow,
} from "./customers.ts";

export type ChatbotPgDatabase = PgDatabase<PgQueryResultHKT>;

export interface DrizzleCustomerStorageOptions {
  /** Test seam. Receives each query builder before it runs. Leave unset in production. */
  onQuery?: (query: { getSQL(): SQL }) => void;
}

function toCustomer(row: ChatbotCustomerRow): CustomerRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    avatar: row.avatar,
    name: row.name,
    email: row.email,
    phone: row.phone,
    chatbotId: row.chatbotId,
    sessionId: row.sessionId,
    countryCode: row.countryCode,
    ipAddress: row.ipAddress,
    chatbotChannel: row.chatbotChannel,
    enabledSound: row.enabledSound,
    preferredLanguage: row.preferredLanguage,
    communicationPreferences: row.communicationPreferences ?? null,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIdentity(row: ChatbotContactIdentityRow): ContactIdentityRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    channel: row.channel,
    identifier: row.identifier,
    normalizedIdentifier: row.normalizedIdentifier,
    verifiedAt: row.verifiedAt,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTag(row: ChatbotCustomerTagRow): TagRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    tag: row.tag,
    tagColor: row.tagColor,
    backgroundColor: row.backgroundColor,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleCustomerStorage implements CustomerStorage {
  constructor(
    private readonly db: ChatbotPgDatabase,
    private readonly options: DrizzleCustomerStorageOptions = {},
  ) {}

  /** Passes a query builder through the test hook and returns it unchanged, so the caller can await it. */
  private q<T extends { getSQL(): SQL }>(query: T): T {
    this.options.onQuery?.(query);
    return query;
  }

  async insertCustomer(companyId: string, input: CustomerInsert, now: Date): Promise<CustomerRecord> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .insert(chatbotCustomers)
        .values({
          ...emptyCustomerFields(),
          ...definedOnly(input),
          id: randomUUID(),
          companyId: scope,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
    return toCustomer(row);
  }

  async findCustomer(companyId: string, id: string): Promise<CustomerRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCustomers)
        .where(and(eq(chatbotCustomers.companyId, scope), eq(chatbotCustomers.id, id)))
        .limit(1),
    );
    return row ? toCustomer(row) : null;
  }

  async listCustomers(companyId: string): Promise<CustomerRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCustomers)
        .where(eq(chatbotCustomers.companyId, scope))
        .orderBy(asc(chatbotCustomers.createdAt), asc(chatbotCustomers.id)),
    );
    return rows.map(toCustomer);
  }

  async updateCustomer(companyId: string, id: string, patch: CustomerPatch, now: Date): Promise<CustomerRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .update(chatbotCustomers)
        .set({ ...definedOnly(patch), updatedAt: now })
        .where(and(eq(chatbotCustomers.companyId, scope), eq(chatbotCustomers.id, id)))
        .returning(),
    );
    return row ? toCustomer(row) : null;
  }

  async deleteCustomer(companyId: string, id: string): Promise<boolean> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .delete(chatbotCustomers)
        .where(and(eq(chatbotCustomers.companyId, scope), eq(chatbotCustomers.id, id)))
        .returning({ id: chatbotCustomers.id }),
    );
    return rows.length > 0;
  }

  async upsertIdentity(companyId: string, input: ContactIdentityUpsert, now: Date): Promise<ContactIdentityRecord> {
    const scope = requireCompanyId(companyId);
    // Conflict target is (company_id, channel, normalized_identifier). The index is per company, so an
    // upsert can never match another tenant's row.
    const [row] = await this.q(
      this.db
        .insert(chatbotContactIdentities)
        .values({
          id: randomUUID(),
          companyId: scope,
          customerId: input.customerId,
          channel: input.channel,
          identifier: input.identifier,
          normalizedIdentifier: input.normalizedIdentifier,
          verifiedAt: null,
          metadata: input.metadata,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [chatbotContactIdentities.companyId, chatbotContactIdentities.channel, chatbotContactIdentities.normalizedIdentifier],
          set: {
            customerId: input.customerId,
            identifier: input.identifier,
            metadata: input.metadata,
            updatedAt: now,
          },
        })
        .returning(),
    );
    return toIdentity(row);
  }

  async findIdentity(companyId: string, channel: string, normalizedIdentifier: string): Promise<ContactIdentityRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotContactIdentities)
        .where(
          and(
            eq(chatbotContactIdentities.companyId, scope),
            eq(chatbotContactIdentities.channel, channel),
            eq(chatbotContactIdentities.normalizedIdentifier, normalizedIdentifier),
          ),
        )
        .limit(1),
    );
    return row ? toIdentity(row) : null;
  }

  async findIdentitiesByNormalizedValue(companyId: string, normalizedIdentifier: string): Promise<ContactIdentityRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotContactIdentities)
        .where(
          and(
            eq(chatbotContactIdentities.companyId, scope),
            eq(chatbotContactIdentities.normalizedIdentifier, normalizedIdentifier),
          ),
        ),
    );
    return rows.map(toIdentity);
  }

  async listIdentitiesForCustomer(companyId: string, customerId: string): Promise<ContactIdentityRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotContactIdentities)
        .where(and(eq(chatbotContactIdentities.companyId, scope), eq(chatbotContactIdentities.customerId, customerId)))
        .orderBy(asc(chatbotContactIdentities.createdAt), asc(chatbotContactIdentities.id)),
    );
    return rows.map(toIdentity);
  }

  async deleteIdentitiesForCustomer(companyId: string, customerId: string): Promise<number> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .delete(chatbotContactIdentities)
        .where(and(eq(chatbotContactIdentities.companyId, scope), eq(chatbotContactIdentities.customerId, customerId)))
        .returning({ id: chatbotContactIdentities.id }),
    );
    return rows.length;
  }

  async linkConversationCustomer(companyId: string, conversationId: string, customerId: string): Promise<void> {
    const scope = requireCompanyId(companyId);
    await this.q(
      this.db
        .insert(chatbotCustomerConversations)
        .values({ companyId: scope, conversationId, customerId })
        .onConflictDoUpdate({
          target: [chatbotCustomerConversations.companyId, chatbotCustomerConversations.conversationId],
          set: { customerId },
        }),
    );
  }

  async findConversationCustomerId(companyId: string, conversationId: string): Promise<string | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select({ customerId: chatbotCustomerConversations.customerId })
        .from(chatbotCustomerConversations)
        .where(
          and(
            eq(chatbotCustomerConversations.companyId, scope),
            eq(chatbotCustomerConversations.conversationId, conversationId),
          ),
        )
        .limit(1),
    );
    return row ? row.customerId : null;
  }

  async unlinkCustomerConversations(companyId: string, customerId: string): Promise<number> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .delete(chatbotCustomerConversations)
        .where(and(eq(chatbotCustomerConversations.companyId, scope), eq(chatbotCustomerConversations.customerId, customerId)))
        .returning({ conversationId: chatbotCustomerConversations.conversationId }),
    );
    return rows.length;
  }

  async mergeCustomers(companyId: string, targetId: string, sourceId: string, now: Date): Promise<MergeResult | null> {
    const scope = requireCompanyId(companyId);
    // The service rejects a self-merge first. Refusing here too stops a delete of the only copy.
    if (targetId === sourceId) return null;
    return this.db.transaction((tx) => this.mergeWith(tx, scope, targetId, sourceId, now));
  }

  private async mergeWith(tx: ChatbotPgDatabase, scope: string, targetId: string, sourceId: string, now: Date): Promise<MergeResult | null> {
    const both = await this.q(
      tx
        .select({ id: chatbotCustomers.id })
        .from(chatbotCustomers)
        .where(and(eq(chatbotCustomers.companyId, scope), inArray(chatbotCustomers.id, [targetId, sourceId]))),
    );
    if (both.length !== 2) return null;

    const identities = await this.q(
      tx
        .update(chatbotContactIdentities)
        .set({ customerId: targetId, updatedAt: now })
        .where(and(eq(chatbotContactIdentities.companyId, scope), eq(chatbotContactIdentities.customerId, sourceId)))
        .returning({ id: chatbotContactIdentities.id }),
    );
    const links = await this.q(
      tx
        .update(chatbotCustomerConversations)
        .set({ customerId: targetId })
        .where(and(eq(chatbotCustomerConversations.companyId, scope), eq(chatbotCustomerConversations.customerId, sourceId)))
        .returning({ conversationId: chatbotCustomerConversations.conversationId }),
    );
    await this.q(
      tx.delete(chatbotCustomers).where(and(eq(chatbotCustomers.companyId, scope), eq(chatbotCustomers.id, sourceId))),
    );
    return { identitiesMoved: identities.length, conversationsMoved: links.length };
  }

  async insertTag(companyId: string, input: TagInsert, now: Date): Promise<TagRecord> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .insert(chatbotCustomerTags)
        .values({
          id: randomUUID(),
          companyId: scope,
          tag: input.tag,
          tagColor: input.tagColor,
          backgroundColor: input.backgroundColor,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
    return toTag(row);
  }

  async findTag(companyId: string, id: string): Promise<TagRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCustomerTags)
        .where(and(eq(chatbotCustomerTags.companyId, scope), eq(chatbotCustomerTags.id, id)))
        .limit(1),
    );
    return row ? toTag(row) : null;
  }

  async listTags(companyId: string): Promise<TagRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCustomerTags)
        .where(eq(chatbotCustomerTags.companyId, scope))
        .orderBy(asc(chatbotCustomerTags.tag), asc(chatbotCustomerTags.id)),
    );
    return rows.map(toTag);
  }

  async updateTag(companyId: string, id: string, patch: TagPatch, now: Date): Promise<TagRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .update(chatbotCustomerTags)
        .set({ ...definedOnly(patch), updatedAt: now })
        .where(and(eq(chatbotCustomerTags.companyId, scope), eq(chatbotCustomerTags.id, id)))
        .returning(),
    );
    return row ? toTag(row) : null;
  }

  async deleteTag(companyId: string, id: string): Promise<boolean> {
    const scope = requireCompanyId(companyId);
    // Assignments reference the tag, so they go first, in the same transaction.
    return this.db.transaction(async (tx) => {
      const found = await this.q(
        tx
          .select({ id: chatbotCustomerTags.id })
          .from(chatbotCustomerTags)
          .where(and(eq(chatbotCustomerTags.companyId, scope), eq(chatbotCustomerTags.id, id)))
          .limit(1),
      );
      if (found.length === 0) return false;
      await this.q(
        tx
          .delete(chatbotConversationCustomerTags)
          .where(
            and(
              eq(chatbotConversationCustomerTags.companyId, scope),
              eq(chatbotConversationCustomerTags.customerTagId, id),
            ),
          ),
      );
      await this.q(tx.delete(chatbotCustomerTags).where(and(eq(chatbotCustomerTags.companyId, scope), eq(chatbotCustomerTags.id, id))));
      return true;
    });
  }

  async listTagIdsForConversation(companyId: string, conversationId: string): Promise<string[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select({ customerTagId: chatbotConversationCustomerTags.customerTagId })
        .from(chatbotConversationCustomerTags)
        .where(
          and(
            eq(chatbotConversationCustomerTags.companyId, scope),
            eq(chatbotConversationCustomerTags.conversationId, conversationId),
          ),
        )
        .orderBy(asc(chatbotConversationCustomerTags.customerTagId)),
    );
    return rows.map((row) => row.customerTagId);
  }

  async setTagAssignments(companyId: string, conversationId: string, tagIds: string[], now: Date): Promise<void> {
    const scope = requireCompanyId(companyId);
    const unique = [...new Set(tagIds)];
    await this.db.transaction(async (tx) => {
      // Unknown tags, and tags from another company, are dropped, as the in-memory store does.
      const known = unique.length
        ? (
            await this.q(
              tx
                .select({ id: chatbotCustomerTags.id })
                .from(chatbotCustomerTags)
                .where(and(eq(chatbotCustomerTags.companyId, scope), inArray(chatbotCustomerTags.id, unique))),
            )
          ).map((row) => row.id)
        : [];
      await this.q(
        tx
          .delete(chatbotConversationCustomerTags)
          .where(
            and(
              eq(chatbotConversationCustomerTags.companyId, scope),
              eq(chatbotConversationCustomerTags.conversationId, conversationId),
            ),
          ),
      );
      if (known.length > 0) {
        await this.q(
          tx.insert(chatbotConversationCustomerTags).values(
            known.map((customerTagId) => ({
              id: randomUUID(),
              companyId: scope,
              conversationId,
              customerTagId,
              createdAt: now,
              updatedAt: now,
            })),
          ),
        );
      }
    });
  }

  async addTagAssignment(companyId: string, conversationId: string, tagId: string, now: Date): Promise<boolean> {
    const scope = requireCompanyId(companyId);
    const [tag] = await this.q(
      this.db
        .select({ id: chatbotCustomerTags.id })
        .from(chatbotCustomerTags)
        .where(and(eq(chatbotCustomerTags.companyId, scope), eq(chatbotCustomerTags.id, tagId)))
        .limit(1),
    );
    if (!tag) return false;
    const inserted = await this.q(
      this.db
        .insert(chatbotConversationCustomerTags)
        .values({ id: randomUUID(), companyId: scope, conversationId, customerTagId: tagId, createdAt: now, updatedAt: now })
        .onConflictDoNothing({
          target: [
            chatbotConversationCustomerTags.companyId,
            chatbotConversationCustomerTags.conversationId,
            chatbotConversationCustomerTags.customerTagId,
          ],
        })
        .returning({ id: chatbotConversationCustomerTags.id }),
    );
    // An empty result means the pair was already assigned.
    return inserted.length > 0;
  }

  async removeTagAssignment(companyId: string, conversationId: string, tagId: string): Promise<boolean> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .delete(chatbotConversationCustomerTags)
        .where(
          and(
            eq(chatbotConversationCustomerTags.companyId, scope),
            eq(chatbotConversationCustomerTags.conversationId, conversationId),
            eq(chatbotConversationCustomerTags.customerTagId, tagId),
          ),
        )
        .returning({ id: chatbotConversationCustomerTags.id }),
    );
    return rows.length > 0;
  }
}
