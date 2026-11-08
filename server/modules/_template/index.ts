/**
 * {{title}} module entry point.
 *
 * Usage (for example in server/routes.ts):
 *   import { register{{pascal}}Module } from "./modules/{{name}}";
 *   register{{pascal}}Module(app, { storage: myStorage });
 *
 * Storage is injected. Pass an implementation in tests, or leave it out to use the
 * Drizzle placeholder in {{name}}-storage.ts.
 */
import type { Express } from "express";
import { create{{pascal}}Router } from "./{{name}}-routes";
import { create{{pascal}}Service, type {{pascal}}Service } from "./{{name}}-service";
import { createDrizzle{{pascal}}Storage, type {{pascal}}Storage } from "./{{name}}-storage";

export interface Register{{pascal}}Options {
  /** Storage implementation. Defaults to the Drizzle placeholder. */
  storage?: {{pascal}}Storage;
  /** Mount path for the module's routes. */
  basePath?: string;
}

export interface Registered{{pascal}}Module {
  service: {{pascal}}Service;
  basePath: string;
}

export function register{{pascal}}Module(
  app: Express,
  options: Register{{pascal}}Options = {},
): Registered{{pascal}}Module {
  const storage = options.storage ?? createDrizzle{{pascal}}Storage();
  const service = create{{pascal}}Service({ storage });
  const basePath = options.basePath ?? "/api/{{name}}";

  app.use(basePath, create{{pascal}}Router(service));

  return { service, basePath };
}

export type { {{pascal}}Service, {{pascal}}Storage };
export { {{pascal}}Error } from "./{{name}}-service";
