/**
 * Storage contract for chatbot customers, contact identities, conversation-customer links and customer tags.
 *
 * Every method takes companyId as its first argument and only reads or writes rows carrying it, the same
 * rule as chatbot-storage.ts. requireCompanyId() runs inside every method, so a missing tenant fails closed
 * at the storage layer too. Only the in-memory implementation lives here. The Drizzle tables are drafted in
 * ./schema.DRAFT.ts and are not promoted yet.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";

/** Fields a customer carries. Contact fields are personal data and are never written to logs. */
export interface CustomerFields {
  /** Linked Desk user id. Data only: it is never used for authorization. Company scope is the boundary. */
  userId: string | null;
  avatar: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  chatbotId: string | null;
  sessionId: string | null;
  countryCode: string | null;
  ipAddress: string | null;
  chatbotChannel: string | null;
  /** Notification sound preference. Defaults to true, as in the source migration. */
  enabledSound: boolean;
  preferredLanguage: string | null;
  communicationPreferences: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
}

export type CustomerInsert = Partial<CustomerFields>;
export type CustomerPatch = Partial<CustomerFields>;

export interface CustomerRecord extends CustomerFields {
  id: string;
  companyId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactIdentityUpsert {
  customerId: string;
  channel: string;
  /** The identifier as entered. Kept for display. */
  identifier: string;
  /** Normalised form used for matching. Unique per company and channel. */
  normalizedIdentifier: string;
  metadata: Record<string, unknown>;
}

export interface ContactIdentityRecord {
  id: string;
  companyId: string;
  customerId: string;
  channel: string;
  identifier: string;
  normalizedIdentifier: string;
  verifiedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TagInsert {
  tag: string;
  tagColor: string | null;
  backgroundColor: string | null;
}

export interface TagPatch {
  tag?: string;
  tagColor?: string | null;
  backgroundColor?: string | null;
}

export interface TagRecord extends TagInsert {
  id: string;
  companyId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MergeResult {
  identitiesMoved: number;
  conversationsMoved: number;
}

export interface CustomerStorage {
  insertCustomer(companyId: string, input: CustomerInsert, now: Date): Promise<CustomerRecord>;
  findCustomer(companyId: string, id: string): Promise<CustomerRecord | null>;
  listCustomers(companyId: string): Promise<CustomerRecord[]>;
  updateCustomer(companyId: string, id: string, patch: CustomerPatch, now: Date): Promise<CustomerRecord | null>;
  /** Removes the customer row only. Returns false when the row is not in companyId. */
  deleteCustomer(companyId: string, id: string): Promise<boolean>;

  /** Inserts or updates the identity for (channel, normalizedIdentifier) within companyId. */
  upsertIdentity(companyId: string, input: ContactIdentityUpsert, now: Date): Promise<ContactIdentityRecord>;
  findIdentity(companyId: string, channel: string, normalizedIdentifier: string): Promise<ContactIdentityRecord | null>;
  /**
   * Every identity in companyId with this normalised value, on any channel, whichever customer holds it.
   * Channel is ignored on purpose: the source duplicates() matches on the normalised value alone.
   */
  findIdentitiesByNormalizedValue(companyId: string, normalizedIdentifier: string): Promise<ContactIdentityRecord[]>;
  listIdentitiesForCustomer(companyId: string, customerId: string): Promise<ContactIdentityRecord[]>;
  deleteIdentitiesForCustomer(companyId: string, customerId: string): Promise<number>;

  /** Points a conversation at a customer. One customer per conversation, as in the source column. */
  linkConversationCustomer(companyId: string, conversationId: string, customerId: string): Promise<void>;
  findConversationCustomerId(companyId: string, conversationId: string): Promise<string | null>;
  unlinkCustomerConversations(companyId: string, customerId: string): Promise<number>;

  /**
   * Moves identities and conversation links from sourceId to targetId, then removes the source row.
   * Runs as one call so a real database can wrap it in a transaction. Returns null when either customer
   * is not in companyId, and then nothing changes.
   */
  mergeCustomers(companyId: string, targetId: string, sourceId: string, now: Date): Promise<MergeResult | null>;

  insertTag(companyId: string, input: TagInsert, now: Date): Promise<TagRecord>;
  findTag(companyId: string, id: string): Promise<TagRecord | null>;
  /** Sorted by tag name, then id, as the source index orders them. */
  listTags(companyId: string): Promise<TagRecord[]>;
  updateTag(companyId: string, id: string, patch: TagPatch, now: Date): Promise<TagRecord | null>;
  /** Removes the tag and every assignment of it inside companyId. */
  deleteTag(companyId: string, id: string): Promise<boolean>;

  listTagIdsForConversation(companyId: string, conversationId: string): Promise<string[]>;
  /** Replaces the full tag set of a conversation. Duplicate ids are stored once. Unknown tags are ignored. */
  setTagAssignments(companyId: string, conversationId: string, tagIds: string[], now: Date): Promise<void>;
  /** Returns false when the tag is already assigned, so the pair stays unique. */
  addTagAssignment(companyId: string, conversationId: string, tagId: string, now: Date): Promise<boolean>;
  /** Returns false when the tag was not assigned. */
  removeTagAssignment(companyId: string, conversationId: string, tagId: string): Promise<boolean>;
}

interface CompanyBucket {
  customers: Map<string, CustomerRecord>;
  identities: Map<string, ContactIdentityRecord>;
  conversationCustomers: Map<string, string>;
  tags: Map<string, TagRecord>;
  /** conversationId -> tagId -> assigned at. The Map keys make each pair unique. */
  assignments: Map<string, Map<string, Date>>;
}

/** Copies a record so callers cannot mutate stored state. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Drops keys whose value is undefined, so a partial input never overwrites a stored field with undefined. */
export function definedOnly<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(input) as (keyof T)[]) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

export function emptyCustomerFields(): CustomerFields {
  return {
    userId: null,
    avatar: null,
    name: null,
    email: null,
    phone: null,
    chatbotId: null,
    sessionId: null,
    countryCode: null,
    ipAddress: null,
    chatbotChannel: null,
    enabledSound: true,
    preferredLanguage: null,
    communicationPreferences: null,
    payload: null,
  };
}

export function createMemoryCustomerStorage(): CustomerStorage {
  // Outer key is companyId. Every lookup starts there, so rows are isolated by tenant.
  const buckets = new Map<string, CompanyBucket>();

  const bucket = (companyId: string): CompanyBucket => {
    const id = requireCompanyId(companyId);
    let rows = buckets.get(id);
    if (!rows) {
      rows = {
        customers: new Map(),
        identities: new Map(),
        conversationCustomers: new Map(),
        tags: new Map(),
        assignments: new Map(),
      };
      buckets.set(id, rows);
    }
    return rows;
  };

  return {
    async insertCustomer(companyId, input, now) {
      const b = bucket(companyId);
      const row: CustomerRecord = {
        ...emptyCustomerFields(),
        ...definedOnly(input),
        id: randomUUID(),
        companyId,
        createdAt: now,
        updatedAt: now,
      };
      b.customers.set(row.id, row);
      return copy(row);
    },

    async findCustomer(companyId, id) {
      const row = bucket(companyId).customers.get(id);
      return row ? copy(row) : null;
    },

    async listCustomers(companyId) {
      return [...bucket(companyId).customers.values()].map(copy);
    },

    async updateCustomer(companyId, id, patch, now) {
      const row = bucket(companyId).customers.get(id);
      if (!row) return null;
      Object.assign(row, definedOnly(patch), { updatedAt: now });
      return copy(row);
    },

    async deleteCustomer(companyId, id) {
      return bucket(companyId).customers.delete(id);
    },

    async upsertIdentity(companyId, input, now) {
      const b = bucket(companyId);
      const existing = [...b.identities.values()].find(
        (row) => row.channel === input.channel && row.normalizedIdentifier === input.normalizedIdentifier,
      );
      if (existing) {
        Object.assign(existing, {
          customerId: input.customerId,
          identifier: input.identifier,
          metadata: input.metadata,
          updatedAt: now,
        });
        return copy(existing);
      }
      const row: ContactIdentityRecord = {
        id: randomUUID(),
        companyId,
        customerId: input.customerId,
        channel: input.channel,
        identifier: input.identifier,
        normalizedIdentifier: input.normalizedIdentifier,
        verifiedAt: null,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      };
      b.identities.set(row.id, row);
      return copy(row);
    },

    async findIdentity(companyId, channel, normalizedIdentifier) {
      const row = [...bucket(companyId).identities.values()].find(
        (item) => item.channel === channel && item.normalizedIdentifier === normalizedIdentifier,
      );
      return row ? copy(row) : null;
    },

    async findIdentitiesByNormalizedValue(companyId, normalizedIdentifier) {
      return [...bucket(companyId).identities.values()]
        .filter((row) => row.normalizedIdentifier === normalizedIdentifier)
        .map(copy);
    },

    async listIdentitiesForCustomer(companyId, customerId) {
      return [...bucket(companyId).identities.values()]
        .filter((row) => row.customerId === customerId)
        .map(copy);
    },

    async deleteIdentitiesForCustomer(companyId, customerId) {
      const b = bucket(companyId);
      let removed = 0;
      for (const [id, row] of b.identities) {
        if (row.customerId === customerId) {
          b.identities.delete(id);
          removed += 1;
        }
      }
      return removed;
    },

    async linkConversationCustomer(companyId, conversationId, customerId) {
      bucket(companyId).conversationCustomers.set(conversationId, customerId);
    },

    async findConversationCustomerId(companyId, conversationId) {
      return bucket(companyId).conversationCustomers.get(conversationId) ?? null;
    },

    async unlinkCustomerConversations(companyId, customerId) {
      const b = bucket(companyId);
      let removed = 0;
      for (const [conversationId, linked] of b.conversationCustomers) {
        if (linked === customerId) {
          b.conversationCustomers.delete(conversationId);
          removed += 1;
        }
      }
      return removed;
    },

    async mergeCustomers(companyId, targetId, sourceId, now) {
      const b = bucket(companyId);
      if (!b.customers.has(targetId) || !b.customers.has(sourceId)) return null;

      let identitiesMoved = 0;
      for (const row of b.identities.values()) {
        if (row.customerId === sourceId) {
          row.customerId = targetId;
          row.updatedAt = now;
          identitiesMoved += 1;
        }
      }

      let conversationsMoved = 0;
      for (const [conversationId, linked] of b.conversationCustomers) {
        if (linked === sourceId) {
          b.conversationCustomers.set(conversationId, targetId);
          conversationsMoved += 1;
        }
      }

      b.customers.delete(sourceId);
      return { identitiesMoved, conversationsMoved };
    },

    async insertTag(companyId, input, now) {
      const b = bucket(companyId);
      const row: TagRecord = {
        id: randomUUID(),
        companyId,
        tag: input.tag,
        tagColor: input.tagColor,
        backgroundColor: input.backgroundColor,
        createdAt: now,
        updatedAt: now,
      };
      b.tags.set(row.id, row);
      return copy(row);
    },

    async findTag(companyId, id) {
      const row = bucket(companyId).tags.get(id);
      return row ? copy(row) : null;
    },

    async listTags(companyId) {
      return [...bucket(companyId).tags.values()]
        .sort((a, b) => (a.tag === b.tag ? a.id.localeCompare(b.id) : a.tag.localeCompare(b.tag)))
        .map(copy);
    },

    async updateTag(companyId, id, patch, now) {
      const row = bucket(companyId).tags.get(id);
      if (!row) return null;
      Object.assign(row, definedOnly(patch), { updatedAt: now });
      return copy(row);
    },

    async deleteTag(companyId, id) {
      const b = bucket(companyId);
      if (!b.tags.delete(id)) return false;
      for (const tagIds of b.assignments.values()) tagIds.delete(id);
      return true;
    },

    async listTagIdsForConversation(companyId, conversationId) {
      const tagIds = bucket(companyId).assignments.get(conversationId);
      return tagIds ? [...tagIds.keys()].sort() : [];
    },

    async setTagAssignments(companyId, conversationId, tagIds, now) {
      const b = bucket(companyId);
      const next = new Map<string, Date>();
      for (const tagId of tagIds) {
        if (b.tags.has(tagId)) next.set(tagId, now);
      }
      b.assignments.set(conversationId, next);
    },

    async addTagAssignment(companyId, conversationId, tagId, now) {
      const b = bucket(companyId);
      if (!b.tags.has(tagId)) return false;
      let tagIds = b.assignments.get(conversationId);
      if (!tagIds) {
        tagIds = new Map();
        b.assignments.set(conversationId, tagIds);
      }
      if (tagIds.has(tagId)) return false;
      tagIds.set(tagId, now);
      return true;
    },

    async removeTagAssignment(companyId, conversationId, tagId) {
      return bucket(companyId).assignments.get(conversationId)?.delete(tagId) ?? false;
    },
  };
}
