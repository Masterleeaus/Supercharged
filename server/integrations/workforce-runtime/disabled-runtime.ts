/**
 * Default runtime. Fail-closed: every call is refused with `runtime_not_configured`, so the app
 * starts and runs with no runtime reachable. Nothing here performs I/O.
 */
import {
  WorkforceRuntimeError,
  type WorkforceHealth,
  type WorkforceRuntimePort,
  type WorkforceTask,
  type WorkforceTaskInput,
} from './port.ts';

export class DisabledWorkforceRuntime implements WorkforceRuntimePort {
  readonly kind = 'disabled' as const;
  /** Fixed reason code explaining why the runtime is disabled. Never contains a secret or URL. */
  readonly reason: string;

  constructor(reason: string = 'runtime_not_configured') {
    this.reason = reason;
  }

  private refuse(): never {
    throw new WorkforceRuntimeError('runtime_not_configured');
  }

  async submitTask(_task: WorkforceTaskInput): Promise<WorkforceTask> {
    this.refuse();
  }

  async getTask(_id: string): Promise<WorkforceTask> {
    this.refuse();
  }

  async cancelTask(_id: string): Promise<WorkforceTask> {
    this.refuse();
  }

  async health(): Promise<WorkforceHealth> {
    this.refuse();
  }
}
