/**
 * Startup load of the workforce role catalogue.
 *
 * Loads the catalogue once, validates it with the same rules as the build-time
 * tests, and caches the result. Fails closed: an invalid or unreadable catalogue
 * is logged problem by problem and getActiveCatalogue() returns undefined.
 * Never throws.
 */
import { fileURLToPath } from "node:url";
import { loadRoleCatalogue, RoleCatalogueError, type RoleCatalogue } from "./loader.ts";
import type { ValidationIssue } from "./validate.ts";

export const DEFAULT_ROLE_CATALOGUE_DIR = fileURLToPath(new URL("./roles/", import.meta.url));

export type CatalogueStartupResult =
  | { ok: true; catalogue: RoleCatalogue }
  | { ok: false; problems: readonly ValidationIssue[] };

export type CatalogueStartupLogger = Pick<Console, "log" | "error">;

let activeCatalogue: RoleCatalogue | undefined;

/** The catalogue loaded at startup, or undefined if it was not loaded or is invalid. */
export function getActiveCatalogue(): RoleCatalogue | undefined {
  return activeCatalogue;
}

/**
 * Loads the catalogue from rootDir, caches the outcome, and logs one summary line.
 * On failure every problem is logged on its own line. Returns the outcome and
 * never throws.
 */
export async function loadCatalogueAtStartup(
  rootDir: string = DEFAULT_ROLE_CATALOGUE_DIR,
  logger: CatalogueStartupLogger = console,
): Promise<CatalogueStartupResult> {
  activeCatalogue = undefined;
  let result: CatalogueStartupResult;
  try {
    const catalogue = await loadRoleCatalogue(rootDir);
    result = { ok: true, catalogue };
  } catch (error) {
    const problems: ValidationIssue[] =
      error instanceof RoleCatalogueError
        ? [...error.problems]
        : [{ path: rootDir, message: `could not load catalogue: ${error instanceof Error ? error.message : String(error)}` }];
    result = { ok: false, problems };
  }

  if (result.ok) {
    activeCatalogue = result.catalogue;
    logger.log(`[workforce] role catalogue loaded: ${result.catalogue.size} roles`);
  } else {
    const count = result.problems.length;
    logger.error(
      `[workforce] role catalogue invalid: ${count} problem${count === 1 ? "" : "s"}`,
    );
    for (const problem of result.problems) {
      logger.error(`[workforce]   - ${problem.path}: ${problem.message}`);
    }
  }
  return result;
}
