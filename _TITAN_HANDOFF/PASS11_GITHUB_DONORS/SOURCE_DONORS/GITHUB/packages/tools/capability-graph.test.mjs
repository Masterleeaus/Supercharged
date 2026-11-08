import assert from "node:assert/strict";
import { buildCapabilityGraph, certifyCapabilityGraph } from "./capability-graph.mjs";
import { buildToolHostManifest } from "./tool-host-manifest.mjs";

const tool = (overrides = {}) => ({
  tool_id: "search",
  name: "Search",
  authority_class: "read_or_analysis",
  grants_execution_authority: false,
  company_scope: { canonical_key: "company_id", legacy_keys_authoritative: false },
  current_source_verification: "verified-current",
  current_sources: ["apps/web/search.ts"],
  ...overrides,
});

const actionCapability = (overrides = {}) => ({
  capability_id: "titan.workforce.reassign",
  kind: "host_action",
  semantic_owner: "packages/workforce",
  implementation_owner: "services/workforce",
  provider_kind: "NATIVE_TITAN",
  host_projection: "directadmin_workforce",
  operation: "reassign",
  required_permissions: ["titan.workforce.reassign"],
  default_grants: [],
  grants_execution_authority: false,
  current_source_verification: "verified-current",
  current_sources: ["services/workforce/src/directadmin-workforce-owners.ts"],
  ...overrides,
});

const registry = (tools = [tool()], action_capabilities = []) => ({
  schema: "titan-zero-tool-registry/v1",
  canonical_company_boundary: "company_id",
  tools,
  action_capabilities,
});

const launchMap = (overrides = {}) => ({
  search: {
    tool_id: "search",
    owner: "titan-zero",
    action: "open:search",
    entrypoint: "chatTab.html",
    launch_contract: "titan-tool-launch/v1",
    donor_navigation: false,
    ...overrides.search,
  },
  ...overrides,
});

export function runCapabilityGraphTests() {
  const graph = buildCapabilityGraph({
    registry: registry(),
    launchMap: launchMap(),
    reachablePaths: ["apps/web/search.ts"],
  });
  assert.equal(graph.schema, "titan.zero.capability-graph.v1");
  assert.equal(graph.ok, true);
  assert.deepEqual(graph.matrix, [{
    capability_id: "search",
    owner: "packages/tools",
    implementation: "apps/web/search.ts",
    provider: "titan-zero",
    projection: "titan-zero:open:search",
    verification: "verified",
  }]);

  const historical = buildCapabilityGraph({
    registry: registry([tool({ current_source_verification: "required", current_sources: [], historical_evidence: ["static/search.png"] })]),
    launchMap: launchMap(),
    reachablePaths: ["apps/web/search.ts"],
  });
  assert.equal(historical.nodes[0].lifecycle, "compatibility-only");
  assert.ok(historical.warnings.includes("search:current-source-unverified"));

  const broken = certifyCapabilityGraph({
    registry: registry([tool(), tool({ tool_id: "search" })]),
    launchMap: { search: { ...launchMap().search, action: "" }, orphan: launchMap().search },
    reachablePaths: [],
    projections: [{ owner: "browser", generated_projection: false, capabilities: [{ id: "search", action: "open:search" }] }],
  });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((error) => error.code === "duplicate-capability-id"));
  assert.ok(broken.errors.some((error) => error.code === "unbound-action"));
  assert.ok(broken.errors.some((error) => error.code === "orphan-projection"));
  assert.ok(broken.errors.some((error) => error.code === "unreachable-implementation"));

  const reassign = actionCapability();
  const actionGraph = buildCapabilityGraph({
    registry: registry([tool()], [reassign]),
    launchMap: launchMap(),
    reachablePaths: ["apps/web/search.ts", "services/workforce/src/directadmin-workforce-owners.ts"],
    projections: [{ owner: "directadmin_workforce", generated_projection: true,
      capabilities: [{ id: reassign.capability_id, action: "reassign" }] }],
  });
  const actionNode = actionGraph.nodes.find((node) => node.capability_id === reassign.capability_id);
  assert.equal(actionGraph.ok, true);
  assert.equal(actionNode.capability_kind, "host_action");
  assert.equal(actionNode.projection, "directadmin_workforce");
  assert.equal(actionNode.launch, null);
  assert.deepEqual(actionNode.default_grants, []);
  assert.equal(buildToolHostManifest(registry([tool()], [reassign])).capabilities.some((entry) => entry.id === reassign.capability_id), false);

  const unsafeActionGraph = certifyCapabilityGraph({
    registry: registry([tool()], [actionCapability({ default_grants: ["manager"], grants_execution_authority: true })]),
    launchMap: { ...launchMap(), "titan.workforce.reassign": { action: "open:reassign", entrypoint: "chatTab.html" } },
    reachablePaths: ["apps/web/search.ts", "services/workforce/src/directadmin-workforce-owners.ts"],
  });
  assert.equal(unsafeActionGraph.ok, false);
  assert.ok(unsafeActionGraph.errors.some((error) => error.code === "action-default-grant"));
  assert.ok(unsafeActionGraph.errors.some((error) => error.code === "authority-leak"));
  assert.ok(unsafeActionGraph.errors.some((error) => error.code === "host-action-globally-exposed"));

  return { ok: true, tests: 18 };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(runCapabilityGraphTests()));

