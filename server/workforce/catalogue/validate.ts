import { RoleDefinitionSchema, type RoleDefinition } from "./role.schema.ts";

export type ValidationIssue = { path: string; message: string };

export type RoleResult =
  | { ok: true; role: RoleDefinition }
  | { ok: false; errors: ValidationIssue[] };

export type CatalogueResult =
  | { ok: true; roles: RoleDefinition[] }
  | { ok: false; errors: ValidationIssue[] };

/** Validates one raw role object against the schema, including single-role rules. */
export function validateRoleDefinition(raw: unknown): RoleResult {
  const parsed = RoleDefinitionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, role: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      path: issue.path.length ? issue.path.join(".") : "(root)",
      message: issue.message,
    })),
  };
}

/**
 * Validates a whole catalogue: every role on its own, then cross-role rules
 * (unique ids, and every handoffTo id must name a role in the catalogue).
 */
export function validateCatalogue(roles: readonly unknown[]): CatalogueResult {
  return validateEntries(roles.map((raw, index) => ({ label: `roles[${index}]`, raw })));
}

/**
 * Loads role modules. Each module must export `role` (preferred) or `default`.
 * Errors are reported against `modules[i]` so a failing file is easy to find.
 */
export function loadCatalogue(modules: readonly unknown[]): CatalogueResult {
  const entries: { label: string; raw: unknown }[] = [];
  const errors: ValidationIssue[] = [];
  modules.forEach((mod, index) => {
    const label = `modules[${index}]`;
    if (typeof mod !== "object" || mod === null) {
      errors.push({ path: label, message: "module is not an object" });
      return;
    }
    const record = mod as Record<string, unknown>;
    if ("role" in record) {
      entries.push({ label, raw: record.role });
    } else if ("default" in record) {
      entries.push({ label, raw: record.default });
    } else {
      errors.push({ path: label, message: "module exports neither `role` nor `default`" });
    }
  });
  const result = validateEntries(entries);
  if (errors.length === 0) return result;
  if (result.ok === true) return { ok: false, errors };
  return { ok: false, errors: [...errors, ...result.errors] };
}

function validateEntries(entries: { label: string; raw: unknown }[]): CatalogueResult {
  const errors: ValidationIssue[] = [];
  const roles: RoleDefinition[] = [];

  // Ids as written in the files, including roles that fail other checks, so
  // handoffs to a role with a typo still resolve to a known id.
  // Duplicate ids are checked on the raw ids so an invalid role cannot hide one.
  const knownIds = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry.raw === "object" && entry.raw !== null) {
      const id = (entry.raw as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      const first = knownIds.get(id);
      if (first) {
        errors.push({
          path: `${entry.label}.id`,
          message: `duplicate role id "${id}" (first defined at ${first})`,
        });
      } else {
        knownIds.set(id, entry.label);
      }
    }
  }

  for (const entry of entries) {
    const result = validateRoleDefinition(entry.raw);
    if (result.ok === false) {
      for (const issue of result.errors) {
        errors.push({ path: `${entry.label}.${issue.path}`, message: issue.message });
      }
      continue;
    }
    const role = result.role;
    role.handoffTo.forEach((target, index) => {
      if (!knownIds.has(target)) {
        errors.push({
          path: `${entry.label}.handoffTo.${index}`,
          message: `handoff target "${target}" is not a role in the catalogue`,
        });
      }
    });
    roles.push(role);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, roles };
}
