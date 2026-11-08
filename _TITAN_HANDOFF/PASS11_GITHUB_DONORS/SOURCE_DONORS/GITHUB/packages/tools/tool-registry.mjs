import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.join(__dirname, "TOOL-REGISTRY.json");

export function loadToolRegistry(filePath = REGISTRY_PATH) {
  const registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
  validateToolRegistry(registry);
  return registry;
}

export function validateToolRegistry(registry) {
  if (!registry || registry.schema !== "titan-zero-tool-registry/v1") throw new Error("invalid-tool-registry-schema");
  if (registry.canonical_company_boundary !== "company_id") throw new Error("invalid-company-boundary");
  if (!Array.isArray(registry.tools) || registry.tools.length < 1) throw new Error("empty-tool-registry");
  const seen = new Set();
  for (const tool of registry.tools) {
    if (!tool.tool_id || seen.has(tool.tool_id)) throw new Error("duplicate-or-missing-tool-id");
    seen.add(tool.tool_id);
    if (tool.company_scope?.canonical_key !== "company_id" || tool.company_scope?.legacy_keys_authoritative !== false) throw new Error(`invalid-company-scope:${tool.tool_id}`);
    if (tool.grants_execution_authority !== false) throw new Error(`identity-authority-violation:${tool.tool_id}`);
    if (!Array.isArray(tool.cost_route) || tool.cost_route[0] !== "on_device") throw new Error(`invalid-cost-route:${tool.tool_id}`);
  }
  return true;
}

export function getToolDefinition(toolId, registry = loadToolRegistry()) {
  const tool = registry.tools.find((entry) => entry.tool_id === toolId);
  if (!tool) throw new Error(`unknown-tool:${toolId}`);
  return tool;
}

export function listToolsForRole(role, registry = loadToolRegistry()) {
  return registry.tools.filter((tool) => tool.supported_roles.includes(role));
}

export function listCleaningTools(registry = loadToolRegistry()) {
  return registry.tools.filter((tool) => tool.cleaning_relevance === "high");
}
