/**
 * Stable versions for workforce roles and for the whole catalogue.
 *
 * A role's version is a short hash of the parts of the role that change how
 * an agent behaves: its id, system prompt, tools, tool risk levels, tool
 * access classes, autonomy and channels. Runs record the version they used, so a run can be traced to
 * the exact prompt and policy that produced it. Fields that do not change
 * behaviour (name, description, guardrails, KPIs) are left out on purpose.
 *
 * Arrays are sorted and object keys are sorted before hashing, so the same
 * role always gives the same version regardless of the order it was written in.
 */
import { createHash } from "node:crypto";
import type { RoleDefinition } from "./role.schema.ts";
import type { RoleCatalogue } from "./loader.ts";

/** Number of hex characters kept from the SHA-256 digest. */
const VERSION_LENGTH = 16;

/** The part of a role that a version is computed from. */
export type VersionedRole = Pick<
  RoleDefinition,
  "id" | "systemPrompt" | "tools" | "toolRisk" | "toolAccess" | "autonomy" | "channels"
>;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, VERSION_LENGTH);
}

/** Builds the canonical JSON text that a role version is hashed from. */
function canonicalRole(role: VersionedRole): string {
  const toolRisk = Object.fromEntries(
    Object.keys(role.toolRisk)
      .sort()
      .map((tool) => [tool, role.toolRisk[tool]]),
  );
  const toolAccess = Object.fromEntries(
    Object.keys(role.toolAccess ?? {})
      .sort()
      .map((tool) => [tool, role.toolAccess?.[tool]]),
  );
  // Key order is fixed here, so JSON.stringify output is canonical.
  return JSON.stringify({
    id: role.id,
    systemPrompt: role.systemPrompt,
    tools: [...role.tools].sort(),
    toolRisk,
    toolAccess,
    autonomy: role.autonomy,
    channels: [...role.channels].sort(),
  });
}

/**
 * Returns a short hex version (16 characters) for one role. It changes when
 * the system prompt, tools, tool risk, tool access, autonomy or channels change.
 */
export function roleVersion(role: VersionedRole): string {
  return sha256Hex(canonicalRole(role));
}

/** Returns a map of role id to role version for every role in the catalogue. */
export function catalogueVersions(catalogue: RoleCatalogue): Map<string, string> {
  const versions = new Map<string, string>();
  for (const [id, role] of catalogue) {
    versions.set(id, roleVersion(role));
  }
  return versions;
}

/**
 * Returns one fingerprint (16 hex characters) for the whole catalogue: the
 * SHA-256 of the sorted "id:version" pairs, joined by newlines. It changes
 * when any role's version changes, or when roles are added or removed.
 */
export function catalogueFingerprint(versions: ReadonlyMap<string, string>): string {
  const pairs = [...versions].map(([id, version]) => `${id}:${version}`).sort();
  return sha256Hex(pairs.join("\n"));
}
