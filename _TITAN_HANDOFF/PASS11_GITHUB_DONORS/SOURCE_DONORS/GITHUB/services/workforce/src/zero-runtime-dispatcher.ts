import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  AuthenticatedWorkIdentity as AuthenticatedDispatchIdentity,
  CompanyId,
  WorkId,
  WorkItem,
  WorkCorrelation,
  WorkforceStore,
  WorkforceWorker,
  WorkforceWorkerStore,
  WorkerId,
} from "./index.js";
import { AUTHENTICATED_SESSION_PROOF_TYPE, WorkforceService } from "./index.js";

export type { AuthenticatedWorkIdentity as AuthenticatedDispatchIdentity } from "./index.js";

export type ZeroRuntimeEvent = {
  event_id?: string;
  type: string;
  company_id: CompanyId;
  run_id?: string;
  conversation_id?: string;
  work_id?: WorkId;
  agent_id?: WorkerId;
  evidence_ref?: string | null;
  [key: string]: unknown;
};

export interface ZeroPersistentRuntimePort {
  events: { subscribe(listener: (event: ZeroRuntimeEvent) => void): () => void };
  findByWork?(input: { company_id: CompanyId; work_id: WorkId }): Promise<ZeroRuntimeRun | null>;
  findRecoverableByWork(input: { company_id: CompanyId; work_id: WorkId }): Promise<{
    run_id: string;
    company_id?: CompanyId;
    work_id?: WorkId;
    conversation_id?: string;
    agent_id: WorkerId;
    state: string;
  } | null>;
  start(input: WorkCorrelation & {
    run_id?: string;
    company_id: CompanyId;
    actor_id: string;
    agent_id: WorkerId;
    conversation_id: string;
    work_id: WorkId;
    interaction_id?: string;
    correlation_id?: string;
    role: string;
    messages: Array<{ role: string; content: string }>;
  }): Promise<ZeroRuntimeRun>;
  resume(input: {
    company_id: CompanyId;
    run_id: string;
    input?: { role: string; content: string };
    continuation?: WorkCorrelation & { client_message_id: string; fingerprint: string; interaction_id: string; correlation_id: string };
  }): Promise<ZeroRuntimeRun>;
  isWorkActive?(input: { company_id: CompanyId; work_id: WorkId }): boolean;
  recoverInterrupted?(input: { company_id: CompanyId; run_id: string }): Promise<ZeroRuntimeRun>;
  cancel?(input: {
    company_id: CompanyId;
    run_id: string;
    reason?: string;
    cancellation?: ZeroRuntimeCancellationMetadata;
  }): Promise<ZeroRuntimeRun>;
}

export type ZeroRuntimeRun = {
  run_id: string;
  company_id: CompanyId;
  conversation_id: string;
  work_id: WorkId;
  agent_id: WorkerId;
  state: string;
  result?: unknown;
  messages?: Array<{ evidence_ref?: string | null }>;
  error?: unknown;
  cancellation?: ZeroRuntimeCancellationMetadata & { requested_at: string; reason: string };
};

export type ZeroWorkforceDispatchInput = WorkCorrelation & {
  company_id: CompanyId;
  actor_id: string;
  conversation_id: string;
  interaction_id: string;
  client_message_id: string;
  text?: string;
  correlation_id: string;
  requested_agent_id?: WorkerId;
  continuation_token?: string;
};

export type ZeroRuntimeCancellationMetadata = {
  actor_id?: string;
  interaction_id?: string;
  client_message_id?: string;
  request_id?: string;
  operation_id?: string;
  trace_id?: string;
  correlation_id?: string;
  idempotency_key?: string;
  session_id?: string;
  context_revision?: string | number;
};

export type ZeroRuntimeCancellationInput = WorkCorrelation & ZeroRuntimeCancellationMetadata & {
  company_id: CompanyId;
  actor_id: string;
  conversation_id: string;
  continuation_token: string;
  reason?: string;
};

export type ZeroWorkforceDispatchEvent = {
  id: string;
  kind: string;
  conversation_id: string;
  company_id: CompanyId;
  surface: "zero";
  work_id?: WorkId;
  run_id?: string;
  agent_id?: WorkerId;
  [key: string]: unknown;
};

export type ZeroWorkforceDispatchResult = {
  accepted: true;
  events: ZeroWorkforceDispatchEvent[];
  continuation_token?: string;
};

type Continuation = { work_id: WorkId; run_id: string };
const terminalRuntimeStates = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const waitingWorkStates = new Set(["WAITING", "WAITING_APPROVAL", "WAITING_EXTERNAL"]);
const derivedWorkforceSessionPrefix = "workforce-zero-";

function stripProofMarkers(identity: AuthenticatedDispatchIdentity): AuthenticatedDispatchIdentity {
  const { session_proof_type: _proofType, source_session_required: _sourceRequired, ...legacyIdentity } = identity;
  return legacyIdentity;
}

function isLegacyProofUpgrade(persisted: AuthenticatedDispatchIdentity | undefined, incoming: AuthenticatedDispatchIdentity | undefined): boolean {
  if (!persisted || !incoming || persisted.session_proof_type !== undefined) return false;
  if (persisted.source_session_required !== undefined && typeof persisted.source_session_required !== "boolean") return false;
  const hasSourceField = Object.prototype.hasOwnProperty.call(persisted, "source_session");
  const hasSource = !!persisted.source_session && typeof persisted.source_session === "object" && !Array.isArray(persisted.source_session);
  if (hasSourceField && !hasSource) return false;
  if (persisted.source_session_required === true && !hasSource) return false;
  if (persisted.source_session_required === false && hasSource) return false;
  const sourceDerived = hasSource || persisted.source_session_required === true;
  const derivedId = persisted.session_id.startsWith(derivedWorkforceSessionPrefix);
  if (derivedId && !sourceDerived) return false;
  const expectedType = sourceDerived ? AUTHENTICATED_SESSION_PROOF_TYPE.sourceDerived : AUTHENTICATED_SESSION_PROOF_TYPE.direct;
  return incoming.session_proof_type === expectedType
    && isDeepStrictEqual(stripProofMarkers(persisted), stripProofMarkers(incoming));
}

function required(value: unknown, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function encodeContinuation(value: Continuation): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeContinuation(token: string): Continuation {
  try {
    const parsed = JSON.parse(Buffer.from(required(token, "zero-continuation-required"), "base64url").toString("utf8")) as Partial<Continuation>;
    return {
      work_id: required(parsed.work_id, "zero-continuation-work-id-required"),
      run_id: required(parsed.run_id, "zero-continuation-run-id-required"),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("zero-continuation-")) throw error;
    throw new Error("zero-continuation-invalid");
  }
}

/**
 * Canonical Zero -> Workforce -> persistent runtime bridge.
 *
 * Zero only contributes One's intent and correlation metadata. A real Workforce
 * WorkItem is created and assigned to an existing digital workforce actor before
 * TitanAgentRuntime is entered. This bridge does not grant authority; tool execution
 * remains behind the runtime's Decision/Risk/Authority/ExecutionGateway boundary.
 */
export class ZeroWorkforceRuntimeDispatcher {
  constructor(
    private readonly workforce: WorkforceService,
    private readonly store: WorkforceStore,
    private readonly workers: WorkforceWorkerStore,
    private readonly runtime: ZeroPersistentRuntimePort,
    private readonly atomicWork?: <T>(fn: (workforce: WorkforceService, store: WorkforceStore) => Promise<T>) => Promise<T>,
  ) {}

  async dispatch(input: ZeroWorkforceDispatchInput): Promise<ZeroWorkforceDispatchResult> {
    const normalized = this.normalize(input);
    const runtimeEvents: ZeroRuntimeEvent[] = [];

    const unsubscribe = this.runtime.events.subscribe((event) => {
      if (event.company_id !== normalized.company_id) return;
      if (event.conversation_id && event.conversation_id !== normalized.conversation_id) return;
      runtimeEvents.push(structuredClone(event));
    });

    try {
      if (normalized.continuation_token) return await this.resume(normalized, runtimeEvents);
      return await this.start(normalized, runtimeEvents);
    } finally {
      unsubscribe();
    }
  }

  /** Restore the WorkItem projection from its durable run without executing work. */
  async reconcilePersistedWork(input: { company_id: CompanyId; actor_id: string; work_id: WorkId }): Promise<WorkItem | null> {
    const work = await this.store.get(input.company_id, input.work_id);
    if (!work || work.origin?.actor_id !== input.actor_id || work.origin?.surface !== 'zero') return null;
    const lookup = this.runtime.findByWork ?? this.runtime.findRecoverableByWork;
    const run = await lookup.call(this.runtime, input) as ZeroRuntimeRun | null;
    if (run) {
      this.assertRun(run, input.company_id, work.work_id, work.origin.conversation_id, work.assignee!);
      await this.syncWorkFromRun(run, []);
    }
    return (await this.store.get(input.company_id, input.work_id)) ?? null;
  }

  private normalize(input: ZeroWorkforceDispatchInput): ZeroWorkforceDispatchInput {
    return {
      ...input,
      company_id: required(input.company_id, "zero-company-id-required"),
      actor_id: required(input.actor_id, "zero-actor-id-required"),
      conversation_id: required(input.conversation_id, "zero-conversation-id-required"),
      interaction_id: required(input.interaction_id, "zero-interaction-id-required"),
      client_message_id: required(input.client_message_id, "zero-client-message-id-required"),
      text: input.continuation_token ? String(input.text ?? "").trim() : required(input.text, "zero-text-required"),
      correlation_id: required(input.correlation_id, "zero-correlation-id-required"),
      requested_agent_id: input.requested_agent_id?.trim() || undefined,
      continuation_token: input.continuation_token?.trim() || undefined,
    };
  }

  private workTransaction<T>(fn: (workforce: WorkforceService, store: WorkforceStore) => Promise<T>): Promise<T> {
    return this.atomicWork ? this.atomicWork(fn) : fn(this.workforce, this.store);
  }

  private async start(input: ZeroWorkforceDispatchInput, runtimeEvents: ZeroRuntimeEvent[]): Promise<ZeroWorkforceDispatchResult> {
    const work_id = `zero:${input.conversation_id}:${input.client_message_id}`;
    // Bootstrap changes commit together. Existing partially bootstrapped work uses
    // the same lifecycle, with automatic runtime wake disabled in the transaction.
    const work = await this.workTransaction(async (workforce, store) => {
      let work = await store.get(input.company_id, work_id);
      if (work) { this.assertOrigin(work, input); this.assertReplay(work, input); }
      if (work && !['CREATED', 'READY', 'CLAIMED', 'IN_PROGRESS'].includes(work.state)) return work;
      const worker = await this.resolveWorker(input.company_id, work?.assignee ?? input.requested_agent_id, "getWorker" in store ? store as WorkforceStore & WorkforceWorkerStore : this.workers);
      if (!work) {
        try {
          work = await workforce.create({
            company_id: input.company_id, work_id, objective: input.text!,
            description: 'Intent delegated by One through Zero.', creator: input.actor_id,
            origin: { actor_id: input.actor_id, conversation_id: input.conversation_id, surface: 'zero', correlation_id: input.correlation_id, ...this.correlation(input), dispatch_fingerprint: this.fingerprint(input) },
            team_id: worker.team_id, priority: 50, dependencies: [], required_capabilities: [], context_refs: [], evidence_refs: [],
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'workforce-work-exists') throw error;
          work = await store.get(input.company_id, work_id);
          if (!work) throw error;
          this.assertOrigin(work, input);
          this.assertReplay(work, input);
        }
      }
      if (work.state === 'CREATED') work = await workforce.refreshReadiness(input.company_id, work_id);
      if (!work.assignee) work = await workforce.delegate(input.company_id, work_id, worker.worker_id, input.actor_id);
      if (work.state === 'READY') work = await workforce.claim(input.company_id, work_id, worker.worker_id);
      if (work.state === 'CLAIMED') work = await workforce.start(input.company_id, work_id, worker.worker_id);
      return work;
    });
    const lookup = this.runtime.findByWork ?? this.runtime.findRecoverableByWork;
    let run = await lookup.call(this.runtime, { company_id: input.company_id, work_id }) as ZeroRuntimeRun | null;
    if (!run && work.state === 'IN_PROGRESS' && work.assignee) {
      try {
        run = await this.runtime.start({
          run_id: `zero-work:${work_id}`, company_id: input.company_id, actor_id: input.actor_id,
          agent_id: work.assignee, conversation_id: input.conversation_id, work_id,
          interaction_id: input.interaction_id, correlation_id: work.origin?.correlation_id ?? input.correlation_id,
          ...this.correlation(work.origin ?? input),
          role: 'workforce-manager', messages: [{ role: 'user', content: work.objective }],
        });
      } catch (error) {
        if (!(error instanceof Error) || !['runtime-run-exists', 'runtime-resume-conflict', 'runtime-run-busy-or-recovery-required', 'runtime-run-active'].includes(error.message)) throw error;
        run = await lookup.call(this.runtime, { company_id: input.company_id, work_id }) as ZeroRuntimeRun | null;
      }
    }
    if (run) this.assertRun(run, input.company_id, work_id, input.conversation_id, work.assignee!);
    if (run?.state === 'QUEUED') {
      try { run = await this.runtime.resume({ company_id: input.company_id, run_id: run.run_id }); }
      catch (error) {
        if (!(error instanceof Error) || !['runtime-resume-conflict', 'runtime-run-busy-or-recovery-required', 'runtime-run-terminal', 'runtime-run-active'].includes(error.message)) throw error;
        run = await lookup.call(this.runtime, { company_id: input.company_id, work_id }) as ZeroRuntimeRun | null;
      }
    }
    if (run) {
      this.assertRun(run, input.company_id, work_id, input.conversation_id, work.assignee!);
      await this.syncWorkFromRun(run, runtimeEvents);
    }
    return this.result(input, (await this.store.get(input.company_id, work_id))!, runtimeEvents, run ?? undefined);
  }

  private async resume(input: ZeroWorkforceDispatchInput, runtimeEvents: ZeroRuntimeEvent[]): Promise<ZeroWorkforceDispatchResult> {
    const continuation = decodeContinuation(input.continuation_token!);
    const work = await this.store.get(input.company_id, continuation.work_id);
    if (!work) throw new Error("zero-continuation-work-not-found");
    this.assertOrigin(work, input);
    if (!work.assignee) throw new Error("zero-continuation-work-unassigned");

    const lookup = this.runtime.findByWork ?? this.runtime.findRecoverableByWork;
    const recoverable = await lookup.call(this.runtime, { company_id: input.company_id, work_id: work.work_id });
    if (!recoverable || recoverable.run_id !== continuation.run_id) throw new Error("zero-continuation-run-not-found");
    if (recoverable.agent_id !== work.assignee) throw new Error("zero-continuation-agent-conflict");
    if (recoverable.company_id !== undefined && recoverable.company_id !== input.company_id) throw new Error("zero-runtime-company-conflict");
    if (recoverable.conversation_id !== undefined && recoverable.conversation_id !== input.conversation_id) throw new Error("zero-runtime-conversation-conflict");
    if (recoverable.work_id !== undefined && recoverable.work_id !== work.work_id) throw new Error("zero-runtime-work-conflict");

    const run = await this.runtime.resume({
      company_id: input.company_id,
      run_id: continuation.run_id,
      continuation: { ...this.correlation(input), client_message_id: input.client_message_id, fingerprint: this.fingerprint(input), interaction_id: input.interaction_id, correlation_id: input.correlation_id },
      ...(input.text ? { input: { role: "user", content: input.text } } : {}),
    });
    this.assertRun(run, input.company_id, work.work_id, input.conversation_id, work.assignee);
    await this.syncWorkFromRun(run, runtimeEvents);
    const updated = (await this.store.get(input.company_id, work.work_id))!;
    return this.result(input, updated, runtimeEvents, run);
  }

  /** Explicit recovery only: authenticated replay identity, no model/provider retry. */
  async recoverInterrupted(input: ZeroWorkforceDispatchInput): Promise<ZeroWorkforceDispatchResult> {
    const normalized = this.normalize(input);
    const continuation = normalized.continuation_token ? decodeContinuation(normalized.continuation_token) : null;
    const work_id = continuation?.work_id ?? `zero:${normalized.conversation_id}:${normalized.client_message_id}`;
    if (this.runtime.isWorkActive?.({ company_id: normalized.company_id, work_id })) throw new Error("runtime-run-active");
    const work = await this.store.get(normalized.company_id, work_id);
    if (!work) throw new Error("zero-continuation-work-not-found");
    this.assertOrigin(work, normalized);
    if (!continuation) this.assertReplay(work, normalized);
    const lookup = this.runtime.findByWork ?? this.runtime.findRecoverableByWork;
    const previous = await lookup.call(this.runtime, { company_id: normalized.company_id, work_id }) as ZeroRuntimeRun | null;
    if (!previous || (continuation && previous.run_id !== continuation.run_id)) throw new Error("zero-continuation-run-not-found");
    this.assertRun(previous, normalized.company_id, work_id, normalized.conversation_id, work.assignee!);
    if (!this.runtime.recoverInterrupted) throw new Error("zero-recovery-unavailable");
    const events: ZeroRuntimeEvent[] = [];
    const unsubscribe = this.runtime.events.subscribe(event => {
      if (event.company_id === normalized.company_id && event.run_id === previous.run_id) events.push(structuredClone(event));
    });
    try {
      let run = previous;
      if (!terminalRuntimeStates.has(run.state)) {
        run = await this.runtime.recoverInterrupted({ company_id: normalized.company_id, run_id: run.run_id });
        if (run.state === "WAITING_EXTERNAL") run = await this.runtime.resume({ company_id: normalized.company_id, run_id: run.run_id });
        else if (!terminalRuntimeStates.has(run.state)) throw new Error("zero-execution-recovery-unavailable");
      }
      this.assertRun(run, normalized.company_id, work_id, normalized.conversation_id, work.assignee!);
      await this.syncWorkFromRun(run, events);
      return this.result(normalized, (await this.store.get(normalized.company_id, work_id))!, events, run);
    } finally { unsubscribe(); }
  }

  async cancel(input: ZeroRuntimeCancellationInput): Promise<ZeroWorkforceDispatchResult> {
    const normalized = { ...input, company_id: required(input.company_id, "zero-company-id-required"), actor_id: required(input.actor_id, "zero-actor-id-required"), conversation_id: required(input.conversation_id, "zero-conversation-id-required") };
    const continuation = decodeContinuation(required(input.continuation_token, "zero-continuation-required"));
    const work = await this.store.get(normalized.company_id, continuation.work_id);
    if (!work) throw new Error("zero-continuation-work-not-found");
    this.assertOrigin(work, normalized as ZeroWorkforceDispatchInput);
    const lookup = this.runtime.findByWork ?? this.runtime.findRecoverableByWork;
    const recoverable = await lookup.call(this.runtime, { company_id: normalized.company_id, work_id: work.work_id }) as ZeroRuntimeRun | null;
    if (!recoverable || recoverable.run_id !== continuation.run_id) throw new Error("zero-continuation-run-not-found");
    this.assertRun(recoverable, normalized.company_id, work.work_id, normalized.conversation_id, work.assignee!);
    if (!this.runtime.cancel) throw new Error("zero-cancellation-unavailable");
    const events: ZeroRuntimeEvent[] = [];
    const unsubscribe = this.runtime.events.subscribe(event => { if (event.company_id === normalized.company_id && event.run_id === continuation.run_id) events.push(structuredClone(event)); });
    try {
      const run = await this.runtime.cancel({
        company_id: normalized.company_id,
        run_id: continuation.run_id,
        reason: input.reason ?? "cancelled-by-client",
        cancellation: {
          actor_id: normalized.actor_id,
          interaction_id: normalized.interaction_id,
          client_message_id: normalized.client_message_id,
          request_id: normalized.request_id,
          operation_id: normalized.operation_id,
          trace_id: normalized.trace_id,
          correlation_id: normalized.correlation_id,
          idempotency_key: normalized.idempotency_key,
          session_id: normalized.session_id,
          context_revision: normalized.context_revision,
        },
      });
      this.assertRun(run, normalized.company_id, work.work_id, normalized.conversation_id, work.assignee!);
      await this.syncWorkFromRun(run, events);
      return this.result(normalized as ZeroWorkforceDispatchInput, (await this.store.get(normalized.company_id, work.work_id))!, events, run);
    } finally { unsubscribe(); }
  }

  private async resolveWorker(company_id: CompanyId, requested?: WorkerId, workers: WorkforceWorkerStore = this.workers): Promise<WorkforceWorker> {
    if (requested) {
      const worker = await workers.getWorker(company_id, requested);
      if (!worker || !worker.active || worker.kind !== "digital") throw new Error("zero-requested-agent-unavailable");
      return worker;
    }

    const managers = (await workers.listWorkers(company_id))
      .filter((worker) => worker.active && worker.kind === "digital" && worker.capabilities.includes("work.delegate"))
      .sort((a, b) => a.worker_id.localeCompare(b.worker_id));
    if (!managers.length) throw new Error("zero-workforce-manager-unavailable");
    return managers[0];
  }

  private assertOrigin(work: WorkItem, input: ZeroWorkforceDispatchInput): void {
    if (work.company_id !== input.company_id) throw new Error("zero-work-company-conflict");
    if (work.origin?.conversation_id !== input.conversation_id) throw new Error("zero-work-conversation-conflict");
    if (work.origin?.actor_id !== input.actor_id) throw new Error("zero-work-actor-conflict");
    if (work.origin?.surface !== "zero") throw new Error("zero-work-surface-conflict");
    if (work.origin.authenticated_identity && !isDeepStrictEqual(work.origin.authenticated_identity, input.authenticated_identity)
      && !isLegacyProofUpgrade(work.origin.authenticated_identity, input.authenticated_identity)) {
      throw new Error("zero-work-authenticated-identity-conflict");
    }
    for (const key of ["session_id", "context_revision"] as const) {
      if (work.origin[key] !== undefined && work.origin[key] !== input[key]) throw new Error(`zero-work-${key}-conflict`);
    }
  }

  private correlation(input: WorkCorrelation): WorkCorrelation {
    return Object.fromEntries((["request_id", "operation_id", "trace_id", "idempotency_key", "session_id", "context_revision", "authenticated_identity"] as const)
      .filter(key => input[key] !== undefined).map(key => [key, key === "authenticated_identity" ? Object.fromEntries(Object.entries(input.authenticated_identity!).sort(([a], [b]) => a.localeCompare(b))) : input[key]]));
  }

  private fingerprint(input: ZeroWorkforceDispatchInput): string {
    return createHash("sha256").update(JSON.stringify({ text: input.text, interaction_id: input.interaction_id,
      correlation_id: input.correlation_id, requested_agent_id: input.requested_agent_id ?? null,
      ...this.correlation(input) })).digest("hex");
  }

  private assertReplay(work: WorkItem, input: ZeroWorkforceDispatchInput): void {
    const persistedIdentity = work.origin?.authenticated_identity;
    const fingerprint = this.fingerprint(input);
    const legacyFingerprint = persistedIdentity && input.authenticated_identity
      && isLegacyProofUpgrade(persistedIdentity, input.authenticated_identity)
      ? this.fingerprint({ ...input, authenticated_identity: persistedIdentity })
      : undefined;
    if (work.objective !== input.text || (work.origin?.dispatch_fingerprint
      ? work.origin.dispatch_fingerprint !== fingerprint && work.origin.dispatch_fingerprint !== legacyFingerprint
      : work.origin?.correlation_id !== input.correlation_id)) throw new Error("zero-work-replay-conflict");
  }

  private assertRun(run: ZeroRuntimeRun, company_id: CompanyId, work_id: WorkId, conversation_id: string, agent_id: WorkerId): void {
    if (run.company_id !== company_id) throw new Error("zero-runtime-company-conflict");
    if (run.work_id !== work_id) throw new Error("zero-runtime-work-conflict");
    if (run.conversation_id !== conversation_id) throw new Error("zero-runtime-conversation-conflict");
    if (run.agent_id !== agent_id) throw new Error("zero-runtime-agent-conflict");
  }

  private async syncWorkFromRun(run: ZeroRuntimeRun, runtimeEvents: ZeroRuntimeEvent[]): Promise<void> {
    if (!terminalRuntimeStates.has(run.state) && !run.state.startsWith('WAITING_') && run.state !== 'SUSPENDED') return;
    // WAITING_TOOL/AGENT are in-flight states, not safe user continuation points.
    if (['WAITING_TOOL', 'WAITING_AGENT'].includes(run.state)) return;
    await this.workTransaction(async (workforce, store) => {
      let work = await store.get(run.company_id, run.work_id);
      if (!work || terminalRuntimeStates.has(work.state)) return;
      const target = run.state === 'WAITING_APPROVAL' ? 'WAITING_APPROVAL' : run.state === 'WAITING_EXTERNAL' ? 'WAITING_EXTERNAL' : run.state.startsWith('WAITING_') || run.state === 'SUSPENDED' ? 'WAITING' : run.state;
      if (work.state === target) return;
      const actor = run.agent_id;
      if (waitingWorkStates.has(work.state)) work = await workforce.resume(run.company_id, run.work_id, actor, { wake: false });
      if (work.state === 'READY') work = await workforce.claim(run.company_id, run.work_id, actor);
      if (work.state === 'CLAIMED') work = await workforce.start(run.company_id, run.work_id, actor);
      const evidence = [...new Set([
        ...(run.messages ?? []).map(message => message.evidence_ref).filter((ref): ref is string => typeof ref === 'string' && !!ref),
        ...runtimeEvents.filter(event => event.run_id === run.run_id && typeof event.evidence_ref === 'string' && event.evidence_ref).map(event => String(event.evidence_ref)),
      ])];
      if (run.state === 'COMPLETED') await workforce.complete(run.company_id, run.work_id, actor, run.result, evidence);
      else if (run.state === 'FAILED') await workforce.fail(run.company_id, run.work_id, actor, run.error ?? run.result);
      else if (run.state === 'CANCELLED') await workforce.cancel(run.company_id, run.work_id, actor);
      else await workforce.wait(run.company_id, run.work_id, actor, target as 'WAITING' | 'WAITING_APPROVAL' | 'WAITING_EXTERNAL');
    });
  }

  private result(
    input: ZeroWorkforceDispatchInput,
    work: WorkItem,
    runtimeEvents: ZeroRuntimeEvent[],
    run?: { run_id: string; state: string; agent_id: WorkerId },
  ): ZeroWorkforceDispatchResult {
    const events: ZeroWorkforceDispatchEvent[] = runtimeEvents.filter(event => event.work_id === work.work_id && (!run || event.run_id === run.run_id)).map((event, index) => ({
      ...event,
      id: event.event_id ?? `${event.run_id ?? work.work_id}:${index}`,
      kind: event.type,
      company_id: input.company_id,
      conversation_id: input.conversation_id,
      surface: "zero" as const,
      work_id: event.work_id ?? work.work_id,
      run_id: event.run_id ?? run?.run_id,
      agent_id: event.agent_id ?? run?.agent_id ?? work.assignee,
    }));
    events.push({
      id: `work:${work.work_id}:${work.updated_at}`,
      kind: "work.state",
      actor_id: work.origin?.actor_id,
      correlation_id: work.origin?.correlation_id,
      request_id: work.origin?.request_id,
      operation_id: work.origin?.operation_id,
      trace_id: work.origin?.trace_id,
      idempotency_key: work.origin?.idempotency_key,
      company_id: input.company_id,
      conversation_id: input.conversation_id,
      surface: "zero",
      work_id: work.work_id,
      run_id: run?.run_id,
      agent_id: run?.agent_id ?? work.assignee,
      state: work.state,
    });

    return {
      accepted: true,
      events,
      ...(run && !terminalRuntimeStates.has(run.state)
        ? { continuation_token: encodeContinuation({ work_id: work.work_id, run_id: run.run_id }) }
        : {}),
    };
  }
}
