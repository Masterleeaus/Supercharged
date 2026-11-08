/**
 * Storage contract for the {{pascal}} module.
 *
 * The service depends only on the {{pascal}}Storage interface, so tests and
 * alternative backends can be injected. Two implementations are included:
 *   - createMemory{{pascal}}Storage: in-memory, for tests and local experiments.
 *   - createDrizzle{{pascal}}Storage: placeholder until a real table exists.
 */
import { db } from "../../db";

export interface {{pascal}}Record {
  id: string;
  name: string;
  createdAt: Date;
}

export interface Create{{pascal}}Input {
  name: string;
}

export interface {{pascal}}Storage {
  list(): Promise<{{pascal}}Record[]>;
  findById(id: string): Promise<{{pascal}}Record | null>;
  create(input: Create{{pascal}}Input): Promise<{{pascal}}Record>;
}

export function createMemory{{pascal}}Storage(): {{pascal}}Storage {
  const rows = new Map<string, {{pascal}}Record>();
  let counter = 0;
  return {
    async list() {
      return Array.from(rows.values());
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async create(input) {
      counter += 1;
      const record: {{pascal}}Record = { id: `{{name}}-${counter}`, name: input.name, createdAt: new Date() };
      rows.set(record.id, record);
      return record;
    },
  };
}

/**
 * PLACEHOLDER. Every method throws until a table is wired in. Replace the body with
 * Drizzle queries once the table exists in @shared/schema, for example:
 *
 *   import { desc, eq } from "drizzle-orm";
 *   import { your{{pascal}}Table } from "@shared/schema";
 *   list: () => database.select().from(your{{pascal}}Table).orderBy(desc(your{{pascal}}Table.createdAt)),
 *   findById: async (id) => (await database.select().from(your{{pascal}}Table)
 *     .where(eq(your{{pascal}}Table.id, id)).limit(1))[0] ?? null,
 *   create: async (input) => (await database.insert(your{{pascal}}Table).values(input).returning())[0],
 */
export function createDrizzle{{pascal}}Storage(database: typeof db = db): {{pascal}}Storage {
  const notWired = async (): Promise<never> => {
    throw new Error("{{name}} storage is not wired to a Drizzle table yet");
  };
  return { list: notWired, findById: notWired, create: notWired };
}
