import type { AgentRuntimeAdapter, CompanyId, WorkerId, WorkId, WorkOrigin } from "./index.js";

export interface RecoverableWorkRun {
  run_id: string;
  state: string;
  agent_id: WorkerId;
}

export interface TitanRuntimeStartPort {
  findRecoverableByWork(input: { company_id: CompanyId; work_id: WorkId }): Promise<RecoverableWorkRun | null>;
  resume(input: { company_id: CompanyId; run_id: string }): Promise<unknown>;
  start(input: {
    company_id: CompanyId;
    actor_id: string;
    agent_id: WorkerId;
    conversation_id: string;
    work_id: WorkId;
    role: string;
    messages: Array<{ role: string; content: string }>;
  }): Promise<unknown>;
}

/**
 * Workforce-to-runtime seam. Origin metadata preserves traceability only: it does not
 * carry or imply authority. READY work resumes its persisted company/work-bound run
 * when present; only genuinely new work starts a new runtime.
 */
export class WorkforceRuntimeAdapter implements AgentRuntimeAdapter {
  constructor(private readonly runtime: TitanRuntimeStartPort) {}

  async wake(input: { company_id: CompanyId; worker_id: WorkerId; work_id: WorkId; origin?: WorkOrigin }): Promise<void> {
    const existing = await this.runtime.findRecoverableByWork({
      company_id: input.company_id,
      work_id: input.work_id,
    });

    if (existing) {
      if (existing.agent_id !== input.worker_id) throw new Error("runtime-work-assignee-conflict");
      await this.runtime.resume({ company_id: input.company_id, run_id: existing.run_id });
      return;
    }

    await this.runtime.start({
      company_id: input.company_id,
      actor_id: input.origin?.actor_id?.trim() || input.worker_id,
      agent_id: input.worker_id,
      conversation_id: input.origin?.conversation_id?.trim() || `work:${input.work_id}`,
      work_id: input.work_id,
      role: "workforce-worker",
      messages: [{ role: "system", content: `Work item ${input.work_id} is ready. Load its governed context and continue it.` }],
    });
  }
}
