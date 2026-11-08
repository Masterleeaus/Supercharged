/**
 * Quota enforcement sweep. A worker calls sweepCallLimits on a timer with the companies to check. It takes no
 * clock and starts no timer itself, so the worker owns the schedule.
 *
 * Each company is swept on its own call. One company that fails (a bad id, a storage error) is reported and the
 * sweep carries on with the rest. Error text is a fixed phrase, never a provider or storage message.
 */
import type { VoiceCallService } from "./service.ts";

export const DEFAULT_SWEEP_BATCH = 200;

export interface CallLimitSweepReport {
  companyId: string;
  ok: boolean;
  /** Calls this sweep ended at their cap. */
  ended: number;
  error: string | null;
}

export async function sweepCallLimits(
  service: Pick<VoiceCallService, "enforceLimitsForCompany">,
  companyIds: readonly string[],
  options: { limit?: number } = {},
): Promise<CallLimitSweepReport[]> {
  const limit = options.limit ?? DEFAULT_SWEEP_BATCH;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("sweep batch must be a positive integer");

  const reports: CallLimitSweepReport[] = [];
  for (const companyId of companyIds) {
    try {
      const result = await service.enforceLimitsForCompany(companyId, { limit });
      reports.push(
        result.ok
          ? { companyId, ok: true, ended: result.value.ended, error: null }
          : { companyId, ok: false, ended: 0, error: `refused with status ${result.status}` },
      );
    } catch {
      reports.push({ companyId, ok: false, ended: 0, error: "sweep failed" });
    }
  }
  return reports;
}
