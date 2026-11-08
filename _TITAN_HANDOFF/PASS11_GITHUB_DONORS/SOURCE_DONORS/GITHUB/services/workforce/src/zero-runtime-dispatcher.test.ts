import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkforceService, type WorkforceWorker, type WorkforceWorkerStore } from "./index.js";
import { MemoryWorkforceStore } from "./memory-store.js";
import {
  ZeroWorkforceRuntimeDispatcher,
  type ZeroPersistentRuntimePort,
  type ZeroRuntimeEvent,
  type ZeroRuntimeRun,
} from "./zero-runtime-dispatcher.js";

class MemoryWorkerStore implements WorkforceWorkerStore {
  private rows = new Map<string, WorkforceWorker>();
  private key(company_id: string, worker_id: string) { return `${company_id}\u0000${worker_id}`; }
  async getWorker(company_id: string, worker_id: string) { return this.rows.get(this.key(company_id, worker_id)); }
  async putWorker(worker: WorkforceWorker) { this.rows.set(this.key(worker.company_id, worker.worker_id), structuredClone(worker)); }
  async listWorkers(company_id: string) { return [...this.rows.values()].filter((worker) => worker.company_id === company_id).map((worker) => structuredClone(worker)); }
}

class FakePersistentRuntime implements ZeroPersistentRuntimePort {
  private listeners = new Set<(event: ZeroRuntimeEvent) => void>();
  private run?: ZeroRuntimeRun;
  startState = "COMPLETED";
  resumeState = "COMPLETED";
  subscribedBeforeStart = false;
  starts = 0;
  resumes = 0;

  events = {
    subscribe: (listener: (event: ZeroRuntimeEvent) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  private emit(event: ZeroRuntimeEvent) { for (const listener of this.listeners) listener(event); }

  async findRecoverableByWork(input: { company_id: string; work_id: string }) {
    if (!this.run || this.run.company_id !== input.company_id || this.run.work_id !== input.work_id) return null;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(this.run.state)) return null;
    return { ...this.run };
  }

  async start(input: {
    company_id: string;
    actor_id: string;
    agent_id: string;
    conversation_id: string;
    work_id: string;
    role: string;
    messages: Array<{ role: string; content: string }>;
  }) {
    this.starts += 1;
    this.subscribedBeforeStart = this.listeners.size > 0;
    this.run = {
      run_id: "run-1",
      company_id: input.company_id,
      conversation_id: input.conversation_id,
      work_id: input.work_id,
      agent_id: input.agent_id,
      state: this.startState,
      result: this.startState === "COMPLETED" ? "done" : undefined,
    };
    this.emit({ type: "run.started", event_id: "event-start", ...this.run });
    if (this.startState === "WAITING_APPROVAL") this.emit({ type: "approval.required", event_id: "event-approval", ...this.run });
    if (this.startState === "COMPLETED") this.emit({ type: "run.completed", event_id: "event-complete", ...this.run });
    return { ...this.run };
  }

  async resume(input: { company_id: string; run_id: string; input: { role: string; content: string } }) {
    this.resumes += 1;
    if (!this.run || this.run.company_id !== input.company_id || this.run.run_id !== input.run_id) throw new Error("run-not-found");
    this.run = { ...this.run, state: this.resumeState, result: this.resumeState === "COMPLETED" ? input.input.content : undefined };
    this.emit({ type: "agent.resumed", event_id: "event-resumed", ...this.run });
    if (this.resumeState === "COMPLETED") this.emit({ type: "run.completed", event_id: "event-resume-complete", ...this.run });
    return { ...this.run };
  }
}

async function fixture() {
  const store = new MemoryWorkforceStore();
  const workers = new MemoryWorkerStore();
  const manager: WorkforceWorker = {
    company_id: "company-1",
    worker_id: "manager-1",
    kind: "digital",
    capabilities: ["work.delegate"],
    active: true,
  };
  await workers.putWorker(manager);
  const workforce = new WorkforceService(store, undefined, undefined, workers);
  const runtime = new FakePersistentRuntime();
  const dispatcher = new ZeroWorkforceRuntimeDispatcher(workforce, store, workers, runtime);
  return { store, workers, runtime, dispatcher };
}

const base = {
  company_id: "company-1",
  actor_id: "one-1",
  conversation_id: "conversation-1",
  interaction_id: "interaction-1",
  client_message_id: "message-1",
  text: "Reschedule tomorrow's first job",
  correlation_id: "correlation-1",
};

describe("ZeroWorkforceRuntimeDispatcher", () => {
  it("subscribes before dispatch and creates a correlated WorkItem before entering runtime", async () => {
    const { store, runtime, dispatcher } = await fixture();
    const result = await dispatcher.dispatch(base);

    assert.equal(runtime.subscribedBeforeStart, true);
    assert.equal(runtime.starts, 1);
    const work = (await store.list("company-1"))[0];
    assert.equal(work.state, "COMPLETED");
    assert.equal(work.assignee, "manager-1");
    assert.match(work.origin!.dispatch_fingerprint!, /^[a-f0-9]{64}$/);
    const { dispatch_fingerprint, ...origin } = work.origin!;
    assert.deepEqual(origin, {
      actor_id: "one-1",
      conversation_id: "conversation-1",
      surface: "zero",
      correlation_id: "correlation-1",
    });
    assert.equal(result.events.some((event) => event.kind === "run.started" && event.work_id === work.work_id), true);
    assert.equal(result.events.at(-1)?.kind, "work.state");
    assert.equal(result.continuation_token, undefined);
  });

  it("resumes the same company/work/run/agent chain from an opaque continuation token", async () => {
    const { store, runtime, dispatcher } = await fixture();
    runtime.startState = "WAITING_APPROVAL";
    const first = await dispatcher.dispatch(base);

    assert.ok(first.continuation_token);
    let work = (await store.list("company-1"))[0];
    assert.equal(work.state, "WAITING_APPROVAL");

    const second = await dispatcher.dispatch({
      ...base,
      interaction_id: "interaction-2",
      client_message_id: "message-2",
      text: "Approved, continue",
      correlation_id: "correlation-2",
      continuation_token: first.continuation_token,
    });

    work = (await store.list("company-1"))[0];
    assert.equal(runtime.starts, 1);
    assert.equal(runtime.resumes, 1);
    assert.equal(work.state, "COMPLETED");
    assert.equal(work.work_id, "zero:conversation-1:message-1");
    assert.equal(second.events.some((event) => event.kind === "agent.resumed" && event.run_id === "run-1"), true);
    assert.equal(second.continuation_token, undefined);
  });

  it("rejects continuation across a different One conversation", async () => {
    const { runtime, dispatcher } = await fixture();
    runtime.startState = "WAITING_APPROVAL";
    const first = await dispatcher.dispatch(base);
    assert.ok(first.continuation_token);

    await assert.rejects(
      () => dispatcher.dispatch({ ...base, conversation_id: "conversation-2", continuation_token: first.continuation_token }),
      /zero-work-conversation-conflict/,
    );
  });

  it("is idempotent for a repeated client message and does not start a duplicate run", async () => {
    const { runtime, dispatcher } = await fixture();
    runtime.startState = "WAITING_APPROVAL";
    const first = await dispatcher.dispatch(base);
    const second = await dispatcher.dispatch(base);

    assert.equal(runtime.starts, 1);
    assert.ok(first.continuation_token);
    assert.ok(second.continuation_token);
  });
});
