import { executionEvidenceToBusinessEvidence } from "./business-evidence-adapter.mjs";
import { ExecutionGateway } from "./execution-gateway.mjs";

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const persisted = row => ({
  evidence_id: row.evidence_id ?? row.id,
  evidence_version: row.evidence_version ?? 1,
  company_id: row.company_id,
  event_type: row.event_type ?? row.evidence_type,
  subject_type: row.subject_type,
  subject_id: row.subject_id,
  classification: row.classification ?? "factual",
  acceptance_state: row.acceptance_state ?? "accepted",
  source_type: row.source_type,
  source_id: row.source_id,
  actor_id: row.actor_id ?? null,
  agent_id: row.agent_id ?? null,
  correlation_id: row.correlation_id,
  causation_id: row.causation_id ?? null,
  decision_id: row.decision_id ?? null,
  authority_decision_id: row.authority_decision_id ?? null,
  execution_id: row.execution_id ?? null,
  verification_id: row.verification_id ?? null,
  projection_version: row.projection_version,
  supersedes_evidence_id: row.supersedes_evidence_id ?? null,
  occurred_at: row.occurred_at,
  accepted_at: row.accepted_at,
  provenance: row.provenance ?? {},
  payload: row.payload ?? {},
});
const same = (a, b) => JSON.stringify(stable(persisted(a))) === JSON.stringify(stable(persisted(b)));

/**
 * Bridges ExecutionGateway lifecycle records into the company-scoped canonical
 * evidence store. Event IDs are stable across retries, so a failed second append
 * can be recovered by replaying the original gateway record.
 */
export function createBusinessEvidenceExecutionSink({ store, projection_version = "execution-reality.v1" } = {}) {
  if (!store || typeof store.append !== "function" || typeof store.get !== "function") {
    throw new Error("business-evidence-store-required");
  }

  async function appendIdempotently(entry) {
    const existing = await store.get(entry.company_id, entry.evidence_id);
    if (existing) {
      if (!same(existing, entry)) throw new Error("business-evidence-id-collision");
      return existing;
    }
    try {
      return await store.append(entry);
    } catch (error) {
      const raced = await store.get(entry.company_id, entry.evidence_id);
      if (raced && same(raced, entry)) return raced;
      throw error;
    }
  }

  return async function persistExecutionEvidence(source) {
    const execution = executionEvidenceToBusinessEvidence(source, { projection_version });
    await appendIdempotently(execution);

    // Only the gateway's independently verified outcome may change job reality.
    // The derived row is separate and stable-ID replay repairs a crash between
    // the execution receipt and job projection append.
    if (source.state === "VERIFIED" && source.work_id && String(source.capability ?? "").startsWith("job.")) {
      const observed = source.observed_result ?? {};
      const status = observed.status ?? observed.state ?? source.final_outcome;
      const fact = Object.freeze({
        ...execution,
        evidence_id: `${source.evidence_id}:job-reality`,
        event_type: "job.status.verified",
        subject_type: "job",
        subject_id: source.work_id,
        causation_id: source.evidence_id,
        verification_id: execution.verification_id,
        payload: Object.freeze({ status }),
      });
      await appendIdempotently(fact);
    }
  };
}

/** Construct an ExecutionGateway whose lifecycle sink cannot bypass the canonical store. */
export function createBusinessEvidenceExecutionGateway({ store, projection_version, ...gatewayOptions } = {}) {
  if (Object.prototype.hasOwnProperty.call(gatewayOptions, "evidenceSink")) {
    throw new Error("business-evidence-sink-override-forbidden");
  }
  return new ExecutionGateway({
    ...gatewayOptions,
    evidenceSink: createBusinessEvidenceExecutionSink({ store, projection_version }),
  });
}
