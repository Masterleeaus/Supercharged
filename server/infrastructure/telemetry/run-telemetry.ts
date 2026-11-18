/**
 * Agent run telemetry (Phase 1, W7, issue #381).
 *
 * Wraps a RunEngine so that run start, finish and failure each emit one span through the injected Telemetry.
 * The wrapper never changes what the engine returns or throws.
 *
 * Span names:
 * - 'agent.run.start'    on startRun. Attributes: run_id, company_id, outcome ('started' or 'rejected').
 * - 'agent.run.finish'   on complete or cancel. Attributes: run_id, company_id, outcome ('completed' or 'cancelled').
 * - 'agent.run.failure'  on fail. Attributes: run_id, company_id, outcome ('failed').
 *
 * What is never emitted: the caller's free-text reason, the run params, tool arguments, tool output, message
 * bodies and any credential. The only text that can reach a span is the engine's fixed refusal code, which
 * is an enum value and is set only when the engine refuses the call.
 *
 * company_id is attached only when it is a non-empty string. An invalid company is still reported, with no
 * company_id, so a bad caller cannot put arbitrary text on the span.
 *
 * Licence: original TitanZero code.
 */
import type { RunEngine, RunResult } from '../../workforce/runtime/run.ts';
import type { SpanAttributes } from './redact.ts';
import type { Telemetry, TelemetrySpan } from './tracer.ts';

export const RUN_START_SPAN = 'agent.run.start';
export const RUN_FINISH_SPAN = 'agent.run.finish';
export const RUN_FAILURE_SPAN = 'agent.run.failure';

type RunEngineMethods = Pick<RunEngine, 'startRun' | 'complete' | 'fail' | 'cancel'>;

function baseAttrs(companyId: unknown, runId: unknown): SpanAttributes {
  const attrs: SpanAttributes = {};
  if (typeof runId === 'string' && runId.trim() !== '') attrs.run_id = runId;
  if (typeof companyId === 'string' && companyId.trim() !== '') attrs.company_id = companyId;
  return attrs;
}

/** Sets the outcome on the span. A refused call also carries the engine's fixed reason code. */
function settle(span: TelemetrySpan, result: RunResult, okOutcome: string): void {
  const attrs: SpanAttributes = result.ok
    ? { outcome: okOutcome }
    : { outcome: 'rejected', refusal_code: String(result.reason) };
  span.setAttributes(attrs);
}

/**
 * Returns a RunEngine whose start, finish and failure methods emit telemetry. Every other method is passed
 * through unchanged. When telemetry is disabled, the input engine is returned as it is.
 */
export function withRunTelemetry<E extends RunEngineMethods>(engine: E, telemetry: Telemetry): E {
  if (!telemetry.enabled) return engine;
  return {
    ...engine,
    startRun: (companyId, runId) =>
      telemetry.withSpan(RUN_START_SPAN, baseAttrs(companyId, runId), async (span) => {
        const result = await engine.startRun(companyId, runId);
        settle(span, result, 'started');
        return result;
      }),
    complete: (companyId, runId, reason) =>
      telemetry.withSpan(RUN_FINISH_SPAN, baseAttrs(companyId, runId), async (span) => {
        const result = await engine.complete(companyId, runId, reason);
        settle(span, result, 'completed');
        return result;
      }),
    cancel: (companyId, runId, reason) =>
      telemetry.withSpan(RUN_FINISH_SPAN, baseAttrs(companyId, runId), async (span) => {
        const result = await engine.cancel(companyId, runId, reason);
        settle(span, result, 'cancelled');
        return result;
      }),
    // The caller's reason is free text. It goes to the engine but is never put on the span.
    fail: (companyId, runId, reason) =>
      telemetry.withSpan(RUN_FAILURE_SPAN, baseAttrs(companyId, runId), async (span) => {
        const result = await engine.fail(companyId, runId, reason);
        settle(span, result, 'failed');
        return result;
      }),
  };
}
