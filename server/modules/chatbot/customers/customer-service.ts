/**
 * Customer, contact identity and customer tag rules for the chatbot module.
 *
 * Port of the domain logic in the Chatbot, Customer Tag and Chatbot Agent extensions. Rules that differ
 * from the source are listed in ./DECISIONS.md. Every method takes companyId first and fails closed without
 * a UUID tenant. Each method also checks its feature flag, which is OFF by default.
 *
 * Error messages name fields but never echo contact values, so validation errors do not leak personal data.
 */
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import type {
  ContactIdentityRecord,
  CustomerInsert,
  CustomerPatch,
  CustomerRecord,
  CustomerStorage,
  MergeResult,
  TagRecord,
} from "./customer-storage.ts";

// ---------- feature flags ----------

export interface CustomerFlags {
  /** Customer records, lookup, identity links and conversation links. */
  customers: boolean;
  /** Tag create, edit, delete, assign and remove. */
  tags: boolean;
  /** Merging duplicate customers. Destructive, so it has its own switch. */
  merge: boolean;
}

export const CUSTOMER_FLAG_ENV: Record<keyof CustomerFlags, string> = {
  customers: "CHATBOT_CUSTOMERS_ENABLED",
  tags: "CHATBOT_CUSTOMER_TAGS_ENABLED",
  merge: "CHATBOT_CUSTOMER_MERGE_ENABLED",
};

/**
 * A switch is on only when its value is exactly "true" (integration fix, rule L3). The shared featureEnabled()
 * in server/lib/feature-flags.ts is not used here: it accepts 1, yes and on, and other live modules depend on it.
 */
function switchOn(raw: string | undefined): boolean {
  return raw === "true";
}

/** Reads the three switches. Each defaults to OFF. */
export function readCustomerFlags(env: Record<string, string | undefined> = process.env): CustomerFlags {
  return {
    customers: switchOn(env[CUSTOMER_FLAG_ENV.customers]),
    tags: switchOn(env[CUSTOMER_FLAG_ENV.tags]),
    merge: switchOn(env[CUSTOMER_FLAG_ENV.merge]),
  };
}

// ---------- colour helper ----------

/**
 * Mixes a #rgb or #rrggbb colour toward white by percent. Returns null for anything else.
 * The source calls lightenColor($hex, 55) from a global helper that is not in the extension tree, so this
 * mix-toward-white formula is an assumption. See DECISIONS.md.
 */
export function lightenColor(color: string, percent: number): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const t = Math.min(100, Math.max(0, percent)) / 100;
  const mixed = [0, 2, 4].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(channel + (255 - channel) * t);
  });
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// ---------- validation ----------

const TEXT_MAX = 255;
const PHONE_CHANNELS = new Set(["phone", "sms", "whatsapp"]);

function invalid(message: string): ChatbotError {
  return new ChatbotError(message, 422);
}

function notFound(what: string): ChatbotError {
  return new ChatbotError(`${what} not found`, 404);
}

/** Trims a text field. Blank becomes null. Throws with the field name only, never the value. */
function optionalText(value: unknown, field: string, max = TEXT_MAX): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) throw invalid(`${field} must be at most ${max} characters`);
  return trimmed;
}

function requiredText(value: unknown, field: string, max = TEXT_MAX): string {
  const text = optionalText(value, field, max);
  if (text === null) throw invalid(`${field} is required`);
  return text;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * Normalises a contact identifier for matching. Phone-like channels keep digits only. Other channels are
 * lowercased. An identifier that normalises to nothing is rejected.
 */
export function normalizeIdentifier(channel: string, identifier: string): string {
  const lowered = identifier.trim().toLowerCase();
  const normalized = PHONE_CHANNELS.has(channel) ? lowered.replace(/\D+/g, "") : lowered;
  if (normalized === "") throw invalid("identifier is not valid for this channel");
  return normalized;
}

/** Input for a customer. Every field is optional on create. The form rules apply on update. */
export interface CustomerInput {
  userId?: unknown;
  avatar?: unknown;
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  chatbotId?: unknown;
  sessionId?: unknown;
  countryCode?: unknown;
  ipAddress?: unknown;
  chatbotChannel?: unknown;
  enabledSound?: unknown;
  preferredLanguage?: unknown;
  communicationPreferences?: unknown;
  payload?: unknown;
}

/**
 * Maps raw input to stored fields. When requireContact is set, name, email and phone must be non-empty.
 * That matches ChatbotCustomerRequest, which requires all three on update.
 */
export function parseCustomerInput(input: CustomerInput, requireContact: boolean): CustomerInsert {
  const fields: CustomerInsert = {
    userId: optionalText(input.userId, "userId"),
    avatar: optionalText(input.avatar, "avatar", 65535),
    name: requireContact ? requiredText(input.name, "name") : optionalText(input.name, "name"),
    email: requireContact ? requiredText(input.email, "email") : optionalText(input.email, "email"),
    phone: requireContact ? requiredText(input.phone, "phone") : optionalText(input.phone, "phone"),
    chatbotId: optionalText(input.chatbotId, "chatbotId", 64),
    sessionId: optionalText(input.sessionId, "sessionId", 128),
    countryCode: optionalText(input.countryCode, "countryCode", 32),
    ipAddress: optionalText(input.ipAddress, "ipAddress", 64),
    chatbotChannel: optionalText(input.chatbotChannel, "chatbotChannel", 32),
    preferredLanguage: optionalText(input.preferredLanguage, "preferredLanguage", 16),
    communicationPreferences: optionalObject(input.communicationPreferences, "communicationPreferences"),
    payload: optionalObject(input.payload, "payload"),
  };
  if (input.enabledSound !== undefined) {
    if (typeof input.enabledSound !== "boolean") throw invalid("enabledSound must be a boolean");
    fields.enabledSound = input.enabledSound;
  }
  return fields;
}

// ---------- service ----------

export interface CustomerServiceDeps {
  storage: CustomerStorage;
  /**
   * Company-scoped check that a conversation exists. Wired to the chatbot conversation store at integration.
   * It must return false for another company's conversation.
   */
  conversationExists: (companyId: string, conversationId: string) => Promise<boolean>;
  /** Read on every call, so flags can change at runtime and tests can set them per case. */
  flags?: () => CustomerFlags;
  now?: () => Date;
}

export interface TagInput {
  tag: unknown;
  tagColor?: unknown;
}

export interface TagUpdateInput {
  tag?: unknown;
  tagColor?: unknown;
}

export interface ConversationTags {
  tags: TagRecord[];
  assigned: string[];
}

export interface CustomerService {
  createCustomer(companyId: string, input: CustomerInput): Promise<CustomerRecord>;
  getCustomer(companyId: string, id: string): Promise<CustomerRecord | null>;
  /** Customers with an email, newest first. Matches the source contact index. */
  listContacts(companyId: string): Promise<CustomerRecord[]>;
  updateCustomer(companyId: string, id: string, input: CustomerInput): Promise<CustomerRecord>;
  /** Removes the customer, its identities and its conversation links. Conversations and messages stay. */
  deleteCustomer(companyId: string, id: string): Promise<void>;

  linkIdentity(
    companyId: string,
    customerId: string,
    channel: string,
    identifier: string,
    metadata?: Record<string, unknown>,
  ): Promise<ContactIdentityRecord>;
  lookupCustomer(companyId: string, channel: string, identifier: string): Promise<CustomerRecord | null>;
  /**
   * Identities of other customers in the same company whose normalised value matches one of this customer's,
   * on any channel. Matching ignores channel, as the source duplicates() does.
   */
  findDuplicates(companyId: string, customerId: string): Promise<ContactIdentityRecord[]>;
  mergeCustomers(companyId: string, targetId: string, sourceId: string): Promise<MergeResult>;
  linkConversationToCustomer(companyId: string, conversationId: string, customerId: string): Promise<void>;

  createTag(companyId: string, input: TagInput): Promise<TagRecord>;
  updateTag(companyId: string, id: string, input: TagUpdateInput): Promise<TagRecord>;
  deleteTag(companyId: string, id: string): Promise<void>;
  listTags(companyId: string): Promise<TagRecord[]>;
  listConversationTags(companyId: string, conversationId: string): Promise<ConversationTags>;
  /** Replaces the conversation's tag set. Duplicate ids are collapsed. */
  assignTags(companyId: string, conversationId: string, tagIds: unknown): Promise<string[]>;
  /** Adds one tag. Returns false when it was already assigned. */
  addTag(companyId: string, conversationId: string, tagId: unknown): Promise<boolean>;
  /** Removes one tag. Returns false when it was not assigned. */
  removeTag(companyId: string, conversationId: string, tagId: unknown): Promise<boolean>;
}

export function createCustomerService(deps: CustomerServiceDeps): CustomerService {
  const { storage, conversationExists } = deps;
  const flags = deps.flags ?? (() => readCustomerFlags());
  const now = deps.now ?? (() => new Date());

  /** Checks the tenant first, then the flags. A missing tenant is always a 403, whatever the flags say. */
  const enabled = (companyId: unknown, ...keys: (keyof CustomerFlags)[]): string => {
    const scoped = requireCompanyId(companyId);
    const current = flags();
    for (const key of keys) {
      if (!current[key]) throw new ChatbotError("Feature not enabled", 404);
    }
    return scoped;
  };

  const requireConversation = async (companyId: string, conversationId: unknown): Promise<string> => {
    const id = requiredText(conversationId, "conversationId", 64);
    if (!(await conversationExists(companyId, id))) throw notFound("Conversation");
    return id;
  };

  const requireCustomer = async (companyId: string, id: string): Promise<CustomerRecord> => {
    const customer = await storage.findCustomer(companyId, id);
    if (!customer) throw notFound("Customer");
    return customer;
  };

  const parseTagIds = (value: unknown): string[] => {
    if (!Array.isArray(value)) throw invalid("tagIds must be an array");
    const ids = value.map((item, index) => requiredText(item, `tagIds.${index}`, 64));
    return [...new Set(ids)];
  };

  return {
    async createCustomer(companyId, input) {
      const scoped = enabled(companyId, "customers");
      const fields = parseCustomerInput(input, false);
      return storage.insertCustomer(scoped, fields, now());
    },

    async getCustomer(companyId, id) {
      const scoped = enabled(companyId, "customers");
      return storage.findCustomer(scoped, requiredText(id, "id", 64));
    },

    async listContacts(companyId) {
      const scoped = enabled(companyId, "customers");
      const rows = await storage.listCustomers(scoped);
      return rows
        .filter((row) => row.email !== null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async updateCustomer(companyId, id, input) {
      const scoped = enabled(companyId, "customers");
      await requireCustomer(scoped, id);
      const patch: CustomerPatch = parseCustomerInput(input, true);
      const updated = await storage.updateCustomer(scoped, id, patch, now());
      if (!updated) throw notFound("Customer");
      return updated;
    },

    async deleteCustomer(companyId, id) {
      const scoped = enabled(companyId, "customers");
      await requireCustomer(scoped, id);
      await storage.deleteIdentitiesForCustomer(scoped, id);
      await storage.unlinkCustomerConversations(scoped, id);
      await storage.deleteCustomer(scoped, id);
    },

    async linkIdentity(companyId, customerId, channel, identifier, metadata = {}) {
      const scoped = enabled(companyId, "customers");
      const channelName = requiredText(channel, "channel", 32);
      const rawIdentifier = requiredText(identifier, "identifier");
      await requireCustomer(scoped, customerId);
      return storage.upsertIdentity(
        scoped,
        {
          customerId,
          channel: channelName,
          identifier: rawIdentifier,
          normalizedIdentifier: normalizeIdentifier(channelName, rawIdentifier),
          metadata,
        },
        now(),
      );
    },

    async lookupCustomer(companyId, channel, identifier) {
      const scoped = enabled(companyId, "customers");
      const channelName = requiredText(channel, "channel", 32);
      const normalized = normalizeIdentifier(channelName, requiredText(identifier, "identifier"));
      const identity = await storage.findIdentity(scoped, channelName, normalized);
      if (!identity) return null;
      return storage.findCustomer(scoped, identity.customerId);
    },

    async findDuplicates(companyId, customerId) {
      const scoped = enabled(companyId, "customers");
      await requireCustomer(scoped, customerId);
      const own = await storage.listIdentitiesForCustomer(scoped, customerId);
      const found: ContactIdentityRecord[] = [];
      for (const identity of own) {
        const matches = await storage.findIdentitiesByNormalizedValue(scoped, identity.normalizedIdentifier);
        for (const match of matches) {
          if (match.customerId !== customerId) found.push(match);
        }
      }
      return found;
    },

    async mergeCustomers(companyId, targetId, sourceId) {
      const scoped = enabled(companyId, "customers", "merge");
      if (targetId === sourceId) throw invalid("a customer cannot be merged into itself");
      await requireCustomer(scoped, targetId);
      await requireCustomer(scoped, sourceId);
      const result = await storage.mergeCustomers(scoped, targetId, sourceId, now());
      if (!result) throw notFound("Customer");
      return result;
    },

    async linkConversationToCustomer(companyId, conversationId, customerId) {
      const scoped = enabled(companyId, "customers");
      const conversation = await requireConversation(scoped, conversationId);
      await requireCustomer(scoped, customerId);
      await storage.linkConversationCustomer(scoped, conversation, customerId);
    },

    async createTag(companyId, input) {
      const scoped = enabled(companyId, "tags");
      const tag = requiredText(input.tag, "tag");
      const tagColor = optionalText(input.tagColor, "tagColor", 50);
      return storage.insertTag(
        scoped,
        {
          tag,
          tagColor,
          backgroundColor: tagColor === null ? null : lightenColor(tagColor, 55),
        },
        now(),
      );
    },

    async updateTag(companyId, id, input) {
      const scoped = enabled(companyId, "tags");
      const existing = await storage.findTag(scoped, id);
      if (!existing) throw notFound("Tag");
      const tag = input.tag === undefined ? undefined : requiredText(input.tag, "tag");
      const tagColor = input.tagColor === undefined ? undefined : optionalText(input.tagColor, "tagColor", 50);
      const patch = {
        tag,
        tagColor,
        backgroundColor:
          tagColor === undefined ? undefined : tagColor === null ? null : lightenColor(tagColor, 55),
      };
      const updated = await storage.updateTag(scoped, id, patch, now());
      if (!updated) throw notFound("Tag");
      return updated;
    },

    async deleteTag(companyId, id) {
      const scoped = enabled(companyId, "tags");
      if (!(await storage.deleteTag(scoped, id))) throw notFound("Tag");
    },

    async listTags(companyId) {
      const scoped = enabled(companyId, "tags");
      return storage.listTags(scoped);
    },

    async listConversationTags(companyId, conversationId) {
      const scoped = enabled(companyId, "tags");
      const conversation = await requireConversation(scoped, conversationId);
      const tags = await storage.listTags(scoped);
      const assigned = await storage.listTagIdsForConversation(scoped, conversation);
      return { tags, assigned };
    },

    async assignTags(companyId, conversationId, tagIds) {
      const scoped = enabled(companyId, "tags");
      const conversation = await requireConversation(scoped, conversationId);
      const ids = parseTagIds(tagIds);
      for (const id of ids) {
        if (!(await storage.findTag(scoped, id))) throw invalid("tagIds contains an unknown tag");
      }
      await storage.setTagAssignments(scoped, conversation, ids, now());
      return storage.listTagIdsForConversation(scoped, conversation);
    },

    async addTag(companyId, conversationId, tagId) {
      const scoped = enabled(companyId, "tags");
      const conversation = await requireConversation(scoped, conversationId);
      const id = requiredText(tagId, "tagId", 64);
      if (!(await storage.findTag(scoped, id))) throw invalid("tagId is unknown");
      return storage.addTagAssignment(scoped, conversation, id, now());
    },

    async removeTag(companyId, conversationId, tagId) {
      const scoped = enabled(companyId, "tags");
      const conversation = await requireConversation(scoped, conversationId);
      const id = requiredText(tagId, "tagId", 64);
      return storage.removeTagAssignment(scoped, conversation, id);
    },
  };
}
