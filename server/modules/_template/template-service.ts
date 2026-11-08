/**
 * Business logic for the {{pascal}} module.
 *
 * Holds rules and orchestration only: no Express types, no SQL. Storage is injected
 * through the factory deps so the service can be unit-tested
 * with createMemory{{pascal}}Storage().
 */
import type { {{pascal}}Record, {{pascal}}Storage, Create{{pascal}}Input } from "./{{name}}-storage";

/** Domain error. The routes map `status` to the HTTP response. */
export class {{pascal}}Error extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "{{pascal}}Error";
  }
}

export interface {{pascal}}Service {
  list(): Promise<{{pascal}}Record[]>;
  get(id: string): Promise<{{pascal}}Record | null>;
  create(input: Create{{pascal}}Input): Promise<{{pascal}}Record>;
}

export interface {{pascal}}ServiceDeps {
  storage: {{pascal}}Storage;
}

export function create{{pascal}}Service({ storage }: {{pascal}}ServiceDeps): {{pascal}}Service {
  return {
    list: () => storage.list(),

    get: (id) => storage.findById(id),

    async create(input) {
      // Example rule: names are trimmed and must not be empty. Replace with real rules.
      const name = input.name.trim();
      if (name.length === 0) {
        throw new {{pascal}}Error("name must not be blank", 400);
      }
      return storage.create({ name });
    },
  };
}
