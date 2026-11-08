const clean = (value) => String(value ?? "").trim();
const normalizePath = (value) => clean(value).replaceAll("\\", "/");

function error(code, capability_id, detail) {
  return Object.freeze({ code, capability_id: capability_id || null, detail });
}

function sourceStatus(tool) {
  return clean(tool?.current_source_verification) || "required";
}

function sourcePaths(tool) {
  return [...new Set((tool?.current_sources ?? []).map(normalizePath).filter(Boolean))];
}

function buildNode(tool, launchMap, reachable) {
  const id = clean(tool?.tool_id);
  const route = launchMap?.[id] ?? null;
  const sources = sourcePaths(tool);
  const status = sourceStatus(tool);
  const active = status === "verified-current" && sources.length > 0;
  const reachableImplementation = active && sources.every((path) => reachable.has(path));
  const lifecycle = active ? "active" : "compatibility-only";
  const verification = reachableImplementation ? "verified" : "unverified";

  return Object.freeze({
    capability_id: id,
    owner: "packages/tools",
    lifecycle,
    source_status: status,
    implementation: sources[0] ?? null,
    implementation_sources: Object.freeze(sources),
    provider: clean(route?.owner) || null,
    projection: route?.action && route?.owner ? `${route.owner}:${route.action}` : null,
    verification,
    launch: route,
  });
}

function inspectRegistry(registry, launchMap, reachable) {
  const errors = [];
  const nodes = [];
  const seen = new Set();

  for (const tool of registry?.tools ?? []) {
    const id = clean(tool?.tool_id);
    if (!id) {
      errors.push(error("missing-capability-id", null, "tool_id is required"));
      continue;
    }
    if (seen.has(id)) errors.push(error("duplicate-capability-id", id, "capability IDs must be unique"));
    seen.add(id);

    const node = buildNode(tool, launchMap, reachable);
    nodes.push(node);
    const route = node.launch;
    if (!route || !clean(route.action) || !clean(route.entrypoint)) {
      errors.push(error("unbound-action", id, "active capability has no complete launch binding"));
    } else if (route.tool_id && clean(route.tool_id) !== id) {
      errors.push(error("projection-drift", id, `launch route identifies ${route.tool_id}`));
    }
    if (node.lifecycle === "active" && node.verification !== "verified") {
      errors.push(error("unreachable-implementation", id, "verified-current sources are not reachable from the current source index"));
    }
  }

  // Host actions are canonical capabilities with typed execution contracts, but
  // they are intentionally not ordinary launchable AI tools. Their host
  // projection is exposed only after the host resolves current identity and
  // authority. Keeping this collection separate prevents generic tool-host
  // manifests from publishing management actions.
  for (const action of registry?.action_capabilities ?? []) {
    const id = clean(action?.capability_id ?? action?.id);
    if (!id) {
      errors.push(error("missing-capability-id", null, "action capability_id is required"));
      continue;
    }
    if (seen.has(id)) errors.push(error("duplicate-capability-id", id, "capability IDs must be unique"));
    seen.add(id);

    const sources = sourcePaths(action);
    const status = sourceStatus(action);
    const active = status === "verified-current" && sources.length > 0;
    const reachableImplementation = active && sources.every((path) => reachable.has(path));
    const kindValid = action?.kind === "host_action" && clean(action?.operation)
      && clean(action?.semantic_owner) && clean(action?.implementation_owner)
      && clean(action?.host_projection) && Array.isArray(action?.required_permissions)
      && action.required_permissions.length > 0;
    if (!kindValid) errors.push(error("invalid-host-action-contract", id, "host action requires an owner, operation, projection and permissions"));
    if (action?.grants_execution_authority !== false) errors.push(error("authority-leak", id, "capability declarations never grant authority"));
    if (!Array.isArray(action?.default_grants) || action.default_grants.length !== 0) {
      errors.push(error("action-default-grant", id, "host actions must have no default grants"));
    }
    if (launchMap?.[id]) errors.push(error("host-action-globally-exposed", id, "host actions must not appear in general tool launch maps"));
    if (active && !reachableImplementation) errors.push(error("unreachable-implementation", id, "verified-current action sources are not reachable from the current source index"));
    nodes.push(Object.freeze({
      capability_id: id,
      capability_kind: "host_action",
      owner: "packages/tools",
      semantic_owner: clean(action?.semantic_owner) || null,
      implementation_owner: clean(action?.implementation_owner) || null,
      lifecycle: active ? "active" : "compatibility-only",
      source_status: status,
      implementation: sources[0] ?? null,
      implementation_sources: Object.freeze(sources),
      provider: clean(action?.provider_kind) || "NATIVE_TITAN",
      projection: clean(action?.host_projection) || null,
      operation: clean(action?.operation) || null,
      verification: reachableImplementation ? "verified" : "unverified",
      launch: null,
      grants_execution_authority: false,
      default_grants: Object.freeze([]),
    }));
  }

  for (const id of Object.keys(launchMap ?? {})) {
    if (!seen.has(id)) errors.push(error("orphan-route", id, "launch route has no canonical capability"));
  }

  return { errors, nodes };
}

function inspectProjections(registry, projections, launchMap) {
  const canonical = new Set([
    ...(registry?.tools ?? []).map((tool) => clean(tool?.tool_id)),
    ...(registry?.action_capabilities ?? []).map((action) => clean(action?.capability_id ?? action?.id)),
  ].filter(Boolean));
  const errors = [];
  for (const projection of projections ?? []) {
    const owner = clean(projection?.owner) || "unknown";
    if (projection?.generated_projection !== true && projection?.provenance?.generated_projection !== true) {
      errors.push(error("orphan-projection", owner, "business capability definitions must be generated from packages/tools"));
    }
    for (const capability of projection?.capabilities ?? []) {
      const id = clean(capability?.id ?? capability?.capability_id ?? capability?.tool_id);
      if (!canonical.has(id)) {
        errors.push(error("orphan-projection", id, `${owner} projects an unknown capability`));
        continue;
      }
      const actionCapability = (registry?.action_capabilities ?? []).find((item) => clean(item?.capability_id ?? item?.id) === id);
      const canonicalAction = clean(launchMap?.[id]?.action ?? actionCapability?.operation);
      if (capability.action && canonicalAction && capability.action !== canonicalAction) {
        errors.push(error("stale-projection", id, `${owner} action ${capability.action} differs from ${canonicalAction}`));
      }
    }
  }
  return errors;
}

export function buildCapabilityGraph({ registry, launchMap = {}, reachablePaths = [], projections = [] } = {}) {
  if (!registry || registry.canonical_company_boundary !== "company_id") {
    throw new Error("capability-graph-company-boundary-required");
  }
  const reachable = new Set(reachablePaths.map(normalizePath).filter(Boolean));
  const inspected = inspectRegistry(registry, launchMap, reachable);
  const errors = [...inspected.errors, ...inspectProjections(registry, projections, launchMap)];
  const warnings = inspected.nodes
    .filter((node) => node.lifecycle !== "active")
    .map((node) => `${node.capability_id}:current-source-unverified`);
  const matrix = inspected.nodes
    .filter((node) => node.lifecycle === "active")
    .map((node) => ({
      capability_id: node.capability_id,
      owner: node.owner,
      implementation: node.implementation,
      provider: node.provider,
      projection: node.projection,
      verification: node.verification,
    }));

  return Object.freeze({
    schema: "titan.zero.capability-graph.v1",
    canonical_owner: "packages/tools",
    company_boundary: "company_id",
    authority_boundary: "capability identity never grants execution authority",
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    nodes: Object.freeze(inspected.nodes),
    matrix: Object.freeze(matrix),
  });
}

export function certifyCapabilityGraph(input) {
  return buildCapabilityGraph(input);
}

export function assertCertifiedCapabilityGraph(input) {
  const graph = certifyCapabilityGraph(input);
  if (!graph.ok) {
    throw new Error(`capability-graph-certification-failed:${graph.errors.map((item) => `${item.code}:${item.capability_id ?? ""}`).join("|")}`);
  }
  return graph;
}

