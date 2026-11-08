/**
 * Production loader for the workforce role catalogue.
 *
 * Reads every role file in a folder, validates the whole set with the same
 * rules the tests use (validateCatalogue, including handoffTo resolution), and
 * returns a read-only registry keyed by role id. Fails closed: any problem
 * throws one RoleCatalogueError that lists every problem found.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RoleDefinition } from "./role.schema.ts";
import { validateCatalogue, type ValidationIssue } from "./validate.ts";

export type RoleCatalogue = ReadonlyMap<string, RoleDefinition>;

/** Thrown by loadRoleCatalogue. `problems` holds every issue found, not just the first. */
export class RoleCatalogueError extends Error {
  readonly problems: readonly ValidationIssue[];

  constructor(problems: readonly ValidationIssue[]) {
    const lines = problems.map((p) => `- ${p.path}: ${p.message}`);
    super(
      `Role catalogue failed validation with ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    );
    this.name = "RoleCatalogueError";
    this.problems = problems;
  }
}

/** A Map that cannot be changed after it is built. Reads work as normal. */
class ReadOnlyRoleMap extends Map<string, RoleDefinition> {
  override set(): never {
    throw new TypeError("role catalogue is read-only");
  }
  override delete(): never {
    throw new TypeError("role catalogue is read-only");
  }
  override clear(): never {
    throw new TypeError("role catalogue is read-only");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Loads every role file in rootDir (ignoring files that start with "_" and
 * declaration files), validates the set, and returns the roles by id.
 * Throws RoleCatalogueError if any file fails to import, exports no `role`,
 * or any role fails validation. Each call builds a new registry.
 */
export async function loadRoleCatalogue(rootDir: string): Promise<RoleCatalogue> {
  const problems: ValidationIssue[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.startsWith("_"))
    .sort();

  // Parallel to the roles passed to validateCatalogue, so its `roles[i]` paths
  // can be mapped back to the file name.
  const fileForRole: string[] = [];
  const rawRoles: unknown[] = [];

  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(join(rootDir, file)).href)) as Record<string, unknown>;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push({ path: file, message: `failed to import: ${reason}` });
      continue;
    }
    if (!("role" in mod)) {
      problems.push({ path: file, message: "module does not export `role`" });
      continue;
    }
    fileForRole.push(file);
    rawRoles.push(mod.role);
  }

  if (files.length === 0) {
    problems.push({ path: rootDir, message: "no role files found" });
  }

  const result = validateCatalogue(rawRoles);
  if ("errors" in result) {
    for (const issue of result.errors) {
      problems.push({ ...issue, path: relabel(issue.path, fileForRole) });
    }
  }

  if (problems.length > 0) throw new RoleCatalogueError(problems);

  const registry = new ReadOnlyRoleMap();
  for (const role of "roles" in result ? result.roles : []) {
    Map.prototype.set.call(registry, role.id, deepFreeze(role));
  }
  return Object.freeze(registry);
}

/** Returns the role with this id, or undefined. Never changes the catalogue. */
export function getRole(catalogue: RoleCatalogue, id: string): RoleDefinition | undefined {
  return catalogue.get(id);
}

function relabel(path: string, files: readonly string[]): string {
  return path.replace(/^roles\[(\d+)\]/, (_, index: string) => files[Number(index)] ?? `roles[${index}]`);
}
