/**
 * Storage interface for the chatbot builder routes, plus an in-memory implementation for tests.
 *
 * Every method takes companyId first, and every read and write is scoped by it: a chatbot that belongs to
 * another company is reported as absent (null), the same as a missing id. DrizzleBuilderStorage runs the same
 * contract against the chatbots table (shared/schema.ts) and the builder fragment in ../db/builder.ts. It is
 * not wired into any route yet (see DECISIONS.md).
 *
 * Deviation from endpoint-map.md section 3: the contract lists findChatbot, findBuilderSettings and
 * updateBuilderSettings. Here one findBuilderState and one updateBuilderState carry the same data, so the
 * classic columns and the JSON settings are written in one transaction by construction.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../shared/schema.ts";
import { chatbotAvatars } from "../db/builder.ts";

/** The five classic chatbot columns that already exist in the Desk chatbot table. */
export interface BuilderChatbotRecord {
  id: string;
  title: string;
  language: string;
  welcomeMessage: string | null;
  instructions: string | null;
  active: boolean;
  updatedAt: Date;
}

export interface BuilderStateRecord {
  chatbot: BuilderChatbotRecord;
  /** Wire-named builder keys (configure, customize, embed.trustedDomains). Stored as one JSON object. */
  settings: Record<string, unknown>;
  /** Public id used in the embed snippet. Returned as embed.uuid and never accepted from a request. */
  publicUuid: string;
}

export interface BuilderChatbotPatch {
  title?: string;
  language?: string;
  welcomeMessage?: string;
  instructions?: string;
  active?: boolean;
}

export interface BuilderStatePatch {
  chatbot: BuilderChatbotPatch;
  /** Merged into the stored settings object. Keys not present here are left as they are. */
  settings: Record<string, unknown>;
}

export interface BuilderAvatarRecord {
  id: string;
  /** Null for a preset shared by every company. */
  companyId: string | null;
  path: string;
  url: string;
}

export interface BuilderStorage {
  /** Returns the chatbot and its builder settings, or null when the id is not in this company. */
  findBuilderState(companyId: string, id: string): Promise<BuilderStateRecord | null>;
  /**
   * Applies the chatbot columns and the settings merge in one transaction. Returns the state after the
   * write, or null when the id is not in this company (nothing is written).
   */
  updateBuilderState(
    companyId: string,
    id: string,
    patch: BuilderStatePatch,
    now: Date,
  ): Promise<BuilderStateRecord | null>;
  /**
   * Creates a chatbot for this company with its builder settings, in one write. The company id is the first
   * argument, so a new row can only belong to the caller's company. Returns the stored state.
   */
  createBuilderState(companyId: string, input: BuilderStateCreate, now: Date): Promise<BuilderStateRecord>;
  /** Presets (companyId null) first, then this company's uploads. */
  listChatbotAvatars(companyId: string): Promise<BuilderAvatarRecord[]>;
}

/** Values for a new chatbot. The router has already checked the save rule before this is called. */
export interface BuilderStateCreate {
  chatbot: {
    title: string;
    language: string;
    welcomeMessage: string;
    instructions: string | null;
    active: boolean;
  };
  settings: Record<string, unknown>;
}

/** In-memory storage with seeding helpers for tests. Not used by the router at runtime. */
export interface MemoryBuilderStorage extends BuilderStorage {
  seedChatbot(
    companyId: string,
    input?: Partial<BuilderChatbotRecord>,
    settings?: Record<string, unknown>,
  ): BuilderStateRecord;
  seedAvatar(companyId: string | null, path: string): BuilderAvatarRecord;
}

interface MemoryRow {
  companyId: string;
  chatbot: BuilderChatbotRecord;
  settings: Record<string, unknown>;
  publicUuid: string;
}

export function createMemoryBuilderStorage(): MemoryBuilderStorage {
  const rows = new Map<string, MemoryRow>();
  const avatars: BuilderAvatarRecord[] = [];

  const owned = (companyId: string, id: string): MemoryRow | null => {
    const row = rows.get(id);
    return row && row.companyId === companyId ? row : null;
  };

  // Copies out, so callers cannot mutate stored state through the returned object.
  const view = (row: MemoryRow): BuilderStateRecord =>
    structuredClone({ chatbot: row.chatbot, settings: row.settings, publicUuid: row.publicUuid });

  return {
    async findBuilderState(companyId, id) {
      const row = owned(companyId, id);
      return row ? view(row) : null;
    },

    async updateBuilderState(companyId, id, patch, now) {
      const row = owned(companyId, id);
      if (!row) return null;
      Object.assign(row.chatbot, patch.chatbot, { updatedAt: now });
      Object.assign(row.settings, patch.settings);
      return view(row);
    },

    async createBuilderState(companyId, input, now) {
      const id = randomUUID();
      const chatbot: BuilderChatbotRecord = {
        id,
        title: input.chatbot.title,
        language: input.chatbot.language,
        welcomeMessage: input.chatbot.welcomeMessage,
        instructions: input.chatbot.instructions,
        active: input.chatbot.active,
        updatedAt: now,
      };
      const row: MemoryRow = { companyId, chatbot, settings: { ...input.settings }, publicUuid: randomUUID() };
      rows.set(id, row);
      return view(row);
    },

    async listChatbotAvatars(companyId) {
      const presets = avatars.filter((a) => a.companyId === null);
      const own = avatars.filter((a) => a.companyId === companyId);
      return [...presets, ...own].map((a) => ({ ...a }));
    },

    seedChatbot(companyId, input = {}, settings = {}) {
      const id = input.id ?? randomUUID();
      const chatbot: BuilderChatbotRecord = {
        title: "Untitled",
        language: "en",
        welcomeMessage: null,
        instructions: null,
        active: true,
        updatedAt: new Date("2026-11-01T00:00:00.000Z"),
        ...input,
        id,
      };
      const row: MemoryRow = { companyId, chatbot, settings: { ...settings }, publicUuid: randomUUID() };
      rows.set(id, row);
      return view(row);
    },

    seedAvatar(companyId, path) {
      const avatar: BuilderAvatarRecord = { id: randomUUID(), companyId, path, url: path };
      avatars.push(avatar);
      return { ...avatar };
    },
  };
}

/* ---------- Drizzle implementation ---------- */

type BuilderDb = NodePgDatabase<typeof schema>;
/** What the builder queries need. A transaction handle has the same two methods. */
type BuilderOps = Pick<BuilderDb, "select" | "update" | "execute">;

/**
 * The statements the Drizzle storage runs, built but not executed. Each one filters by company_id, and the
 * builder row is reached through the parent's id and company_id. Exported so tests can render them to SQL
 * without a connection.
 */
export const builderQueries = {
  /** Classic columns from the parent table, scoped to the company. */
  parentState(db: BuilderOps, companyId: string, id: string) {
    return db
      .select({
        id: schema.chatbots.id,
        title: schema.chatbots.title,
        language: schema.chatbots.language,
        welcomeMessage: schema.chatbots.welcomeMessage,
        instructions: schema.chatbots.instructions,
        active: schema.chatbots.active,
        updatedAt: schema.chatbots.updatedAt,
      })
      .from(schema.chatbots)
      .where(and(eq(schema.chatbots.companyId, companyId), eq(schema.chatbots.id, id)))
      .limit(1);
  },

  /**
   * Builder columns, read from the shared chatbots table. They are not on that table definition yet (the owner
   * promotes builderChatbotColumns), so they are named as SQL identifiers, scoped by the parent's id and company_id.
   */
  builderRow(db: BuilderOps, companyId: string, parentId: string) {
    return db
      .select({
        builderSettings: sql<Record<string, unknown>>`${sql.identifier("builder_settings")}`,
        publicUuid: sql<string>`${sql.identifier("public_uuid")}`,
      })
      .from(schema.chatbots)
      .where(and(eq(schema.chatbots.companyId, companyId), eq(schema.chatbots.id, parentId)))
      .limit(1);
  },

  /** Writes the classic columns. Returns the id, so zero rows means the chatbot is not in this company. */
  parentUpdate(db: BuilderOps, companyId: string, id: string, values: Partial<typeof schema.chatbots.$inferInsert>) {
    return db
      .update(schema.chatbots)
      .set(values)
      .where(and(eq(schema.chatbots.companyId, companyId), eq(schema.chatbots.id, id)))
      .returning({ id: schema.chatbots.id });
  },

  /**
   * Shallow jsonb merge: keys in the patch replace the stored key, keys not in it are kept. A raw UPDATE, because
   * builder_settings is not on the shared table definition yet.
   */
  settingsMerge(db: BuilderOps, companyId: string, id: string, settings: Record<string, unknown>) {
    return db.execute(sql`update ${schema.chatbots} set ${sql.identifier("builder_settings")} = ${sql.identifier("builder_settings")} || ${JSON.stringify(settings)}::jsonb where ${and(eq(schema.chatbots.companyId, companyId), eq(schema.chatbots.id, id))}`);
  },

  /**
   * Inserts the classic columns and the builder columns in one statement. company_id comes from the caller, never
   * from the request. builder_settings and public_uuid are raw SQL, as in the other builder statements.
   */
  insertChatbot(
    db: BuilderOps,
    companyId: string,
    values: BuilderStateCreate["chatbot"] & { id: string; publicUuid: string; settings: Record<string, unknown>; now: Date },
  ) {
    return db.execute(sql`insert into ${schema.chatbots} (id, company_id, title, language, welcome_message, instructions, active, updated_at, builder_settings, public_uuid) values (${values.id}, ${companyId}, ${values.title}, ${values.language}, ${values.welcomeMessage}, ${values.instructions}, ${values.active}, ${values.now}, ${JSON.stringify(values.settings)}::jsonb, ${values.publicUuid}::uuid)`);
  },

  /** Presets (company_id null) first, then this company's uploads. Nothing from another company. */
  avatars(db: BuilderOps, companyId: string) {
    return db
      .select({
        id: chatbotAvatars.id,
        companyId: chatbotAvatars.companyId,
        path: chatbotAvatars.path,
      })
      .from(chatbotAvatars)
      .where(or(isNull(chatbotAvatars.companyId), eq(chatbotAvatars.companyId, companyId)))
      .orderBy(sql`${chatbotAvatars.companyId} IS NULL DESC`, asc(chatbotAvatars.createdAt), asc(chatbotAvatars.path));
  },
};

/** Copies only the keys that have a value, so an absent key is never written as null. */
function definedOnly<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

async function readState(
  db: BuilderOps,
  companyId: string,
  id: string,
): Promise<BuilderStateRecord | null> {
  const [parent] = await builderQueries.parentState(db, companyId, id);
  if (!parent) return null;

  const [builder] = await builderQueries.builderRow(db, companyId, parent.id);
  if (!builder) return null;

  return {
    chatbot: {
      id: parent.id,
      title: parent.title,
      language: parent.language,
      welcomeMessage: parent.welcomeMessage,
      instructions: parent.instructions,
      active: parent.active,
      updatedAt: parent.updatedAt,
    },
    settings: builder.builderSettings,
    publicUuid: builder.publicUuid,
  };
}

/**
 * Postgres implementation of BuilderStorage. Every statement carries company_id. The classic columns and the
 * settings merge run in one transaction, so a failed merge does not leave the classic columns changed.
 */
export class DrizzleBuilderStorage implements BuilderStorage {
  constructor(private readonly db: BuilderDb) {}

  async findBuilderState(companyId: string, id: string): Promise<BuilderStateRecord | null> {
    return readState(this.db, companyId, id);
  }

  async updateBuilderState(
    companyId: string,
    id: string,
    patch: BuilderStatePatch,
    now: Date,
  ): Promise<BuilderStateRecord | null> {
    return this.db.transaction(async (tx) => {
      const written = await builderQueries.parentUpdate(tx, companyId, id, {
        ...definedOnly(patch.chatbot),
        updatedAt: now,
      });
      if (written.length === 0) return null;

      if (Object.keys(patch.settings).length > 0) {
        await builderQueries.settingsMerge(tx, companyId, id, patch.settings);
      }
      return readState(tx, companyId, id);
    });
  }

  async createBuilderState(companyId: string, input: BuilderStateCreate, now: Date): Promise<BuilderStateRecord> {
    const id = randomUUID();
    const publicUuid = randomUUID();
    return this.db.transaction(async (tx) => {
      await builderQueries.insertChatbot(tx, companyId, { ...input.chatbot, id, publicUuid, settings: input.settings, now });
      const state = await readState(tx, companyId, id);
      if (!state) throw new Error("chatbot builder: created chatbot not readable in its company");
      return state;
    });
  }

  async listChatbotAvatars(companyId: string): Promise<BuilderAvatarRecord[]> {
    const rows = await builderQueries.avatars(this.db, companyId);
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, path: row.path, url: row.path }));
  }
}
