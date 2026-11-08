import { assertDirectAdminWorkforceSkillsProjection, type DirectAdminWorkforceSkillsProjection, type WorkforceEvidenceBackedSkillProof } from "../../../packages/titan-platform/src/directadmin-workforce-skills.js";
// @ts-expect-error Canonical capability projection is JavaScript.
import { buildEvidenceBackedSkillProof } from "../../../packages/titan-platform/src/ported/titan-workforce/capability/evidence-backed-skill-proof.mjs";

export type CanonicalWorkforceSkillInputs = Readonly<{
  registry: unknown;
  performance?: unknown;
  capability_matrix?: unknown;
}>;

export type CanonicalWorkforceSkillSource = (company_id: string) => Promise<CanonicalWorkforceSkillInputs | null>;

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 1024 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function unavailable(company_id: string, context_revision: string): DirectAdminWorkforceSkillsProjection {
  return Object.freeze({
    schema: "titan.directadmin.workforce-skills.v1", status: "unavailable",
    company_id, context_revision, reason: "canonical-skill-projection-unavailable",
    source: null, freshness: null, source_revision: null, evidence_refs: Object.freeze([]),
    read_only: true, capability_presence_confers_authority: false,
    verification_confers_authority: false, assignment_decision: false, routing_decision: false,
    entitlement_decision: false, execution_permitted: false, grants_authority: false,
  });
}

function sourceFreshness(value: unknown): string | null {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

/** Reuse the canonical evidence-backed proof builder and restrict its input to
 * workers already selected by the authenticated company's Workforce roster. */
export async function projectDirectAdminWorkforceSkills(input: {
  company_id: string;
  context_revision: string;
  worker_ids: readonly string[];
  source?: CanonicalWorkforceSkillSource;
}): Promise<DirectAdminWorkforceSkillsProjection> {
  const { company_id, context_revision } = input;
  if (!id(company_id) || !id(context_revision)) throw new Error("directadmin-workforce-skills-context-invalid");
  if (typeof input.source !== "function") return unavailable(company_id, context_revision);
  try {
    const source = await input.source(company_id);
    if (!source || !record(source.registry)) return unavailable(company_id, context_revision);
    const registry = source.registry;
    if (registry.schema !== "titan.workforce.skill-capability-registry.v1" || registry.company_id !== company_id ||
        registry.grants_authority !== false || registry.execution_permitted !== false ||
        !Array.isArray(registry.worker_capabilities)) return unavailable(company_id, context_revision);

    const roster = new Set(input.worker_ids.filter(id));
    const capabilityRows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const row of registry.worker_capabilities as unknown[]) {
      if (!record(row) || !id(row.worker_id) || !id(row.capability_id) ||
          (row.company_id !== undefined && row.company_id !== company_id)) return unavailable(company_id, context_revision);
      if (!roster.has(row.worker_id)) continue;
      const binding = `${row.worker_id}\u0000${row.capability_id}`;
      if (seen.has(binding)) return unavailable(company_id, context_revision);
      seen.add(binding);
      capabilityRows.push(row);
    }

    const performance = source.performance;
    if (performance !== undefined && performance !== null) {
      if (!record(performance) || performance.schema !== "titan.workforce.performance-outcome-evidence.v1" ||
          performance.company_id !== company_id || performance.grants_authority !== false ||
          performance.execution_permitted !== false || !Array.isArray(performance.worker_performance) ||
          performance.worker_performance.some((row: unknown) => !record(row) || !id(row.worker_id) ||
            (row.company_id !== undefined && row.company_id !== company_id))) {
        return unavailable(company_id, context_revision);
      }
    }
    const matrix = source.capability_matrix;
    if (matrix !== undefined && matrix !== null) {
      if (!record(matrix) || matrix.schema !== "titan.workforce.capability-matrix.v1" ||
          matrix.company_id !== company_id || matrix.grants_authority !== false ||
          matrix.execution_permitted !== false || !Array.isArray(matrix.workers) ||
          matrix.workers.some((row: unknown) => !record(row) || !id(row.worker_id) ||
            (row.company_id !== undefined && row.company_id !== company_id) ||
            (row.capabilities !== undefined && !Array.isArray(row.capabilities)))) {
        return unavailable(company_id, context_revision);
      }
    }

    const filteredRegistry = { ...registry, worker_capabilities: capabilityRows };
    const filteredPerformance = record(performance) ? {
      ...performance,
      worker_performance: list(performance.worker_performance).filter(row => record(row) && roster.has(String(row.worker_id ?? ""))),
    } : null;
    const filteredMatrix = record(matrix) ? {
      ...matrix,
      workers: list(matrix.workers).filter(row => record(row) && roster.has(String(row.worker_id ?? ""))),
    } : null;
    const proof = buildEvidenceBackedSkillProof(
      filteredRegistry,
      filteredPerformance,
      filteredMatrix,
    ) as WorkforceEvidenceBackedSkillProof;
    if (proof.company_id !== company_id || proof.grants_authority !== false ||
        proof.execution_permitted !== false || proof.read_only !== true) return unavailable(company_id, context_revision);

    const evidence_refs = [...new Set(proof.skill_proofs.flatMap(skill => skill.evidence_refs))].sort();
    const source_revision = Number.isSafeInteger(registry.graph_revision) && registry.graph_revision >= 0
      ? registry.graph_revision as number : null;
    const projection = structuredClone(proof);
    const result = Object.freeze({
      schema: "titan.directadmin.workforce-skills.v1", status: "available",
      company_id, context_revision,
      source: "canonical-workforce-skill-capability-registry",
      freshness: sourceFreshness(registry.updated_at), source_revision,
      evidence_refs: Object.freeze(evidence_refs), projection,
      read_only: true, capability_presence_confers_authority: false,
      verification_confers_authority: false, assignment_decision: false, routing_decision: false,
      entitlement_decision: false, execution_permitted: false, grants_authority: false,
    });
    assertDirectAdminWorkforceSkillsProjection(result, {
      company_id, context_revision, worker_ids: [...roster],
    });
    return result;
  } catch {
    // Canonical store/provider details must not become browser diagnostics.
    return unavailable(company_id, context_revision);
  }
}
