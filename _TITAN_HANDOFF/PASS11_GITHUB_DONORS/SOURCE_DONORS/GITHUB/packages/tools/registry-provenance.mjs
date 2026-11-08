import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadToolRegistry } from "./tool-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORICAL_AUTHORITY_FIELDS = new Set(["manager_merge", "manager_rebase", "canonical_sha256", "artifact", "sha256"]);

function walk(value, pathName = "root", findings = []) {
  if (!value || typeof value !== "object") return findings;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${pathName}[${index}]`, findings));
    return findings;
  }
  for (const [key, child] of Object.entries(value)) {
    if (HISTORICAL_AUTHORITY_FIELDS.has(key)) findings.push({ path: `${pathName}.${key}`, value: child });
    walk(child, `${pathName}.${key}`, findings);
  }
  return findings;
}

export function auditRegistryProvenance({ registry, census, launchMap } = {}) {
  const canonicalRegistry = registry ?? loadToolRegistry();
  const canonicalCensus = census ?? JSON.parse(fs.readFileSync(path.join(__dirname, "TOOL-CENSUS.json"), "utf8"));
  const canonicalLaunchMap = launchMap ?? JSON.parse(fs.readFileSync(path.join(__dirname, "TOOL-LAUNCH-MAP.json"), "utf8"));

  const historicalAuthority = [
    ...walk(canonicalRegistry, "registry"),
    ...walk(canonicalCensus, "census"),
    ...walk(canonicalLaunchMap, "launchMap"),
  ];

  const staleSourcePath =
    typeof canonicalRegistry.source_census === "string" &&
    canonicalRegistry.source_census !== "packages/tools/TOOL-CENSUS.json";

  return Object.freeze({
    schema: "titan.zero.tools.registry-provenance-audit.v1",
    canonical_owner: "packages/tools",
    canonical_company_boundary: "company_id",
    historical_metadata_is_authority: false,
    historical_authority_fields: historicalAuthority,
    stale_source_census_path: staleSourcePath ? canonicalRegistry.source_census : null,
    ok: historicalAuthority.length === 0 && !staleSourcePath,
  });
}

export function assertCurrentRegistryProvenance(input) {
  const audit = auditRegistryProvenance(input);
  if (!audit.ok) {
    const fields = audit.historical_authority_fields.map((entry) => entry.path);
    if (audit.stale_source_census_path) fields.push("registry.source_census");
    throw new Error(`stale-tool-registry-provenance:${fields.join(",")}`);
  }
  return audit;
}
