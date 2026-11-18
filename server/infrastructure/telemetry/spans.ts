/**
 * OpenTelemetry spans for VoltAgent agent runs and tool calls.
 *
 * Nothing is traced or exported unless VOLTAGENT_TELEMETRY_ENABLED is exactly "true".
 * When the flag is off, createTelemetry never calls createTracer and every method runs
 * the wrapped function directly.
 *
 * Span attributes pass through redactTelemetryAttributes before they are set. Message
 * text, emails, phone numbers and tokens are never accepted as span input.
 *
 * The exporter and SDK provider are not set up here. The boot wiring supplies
 * createTracer. This module uses only @opentelemetry/api.
 */

import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import { redactTelemetryAttributes, type TelemetryAttributes } from './telemetry-redact.ts';

export const TELEMETRY_FLAG = 'VOLTAGENT_TELEMETRY_ENABLED';
export const AGENT_RUN_SPAN = 'agent.run';
export const TOOL_CALL_SPAN = 'tool.call';
const TRACER_NAME = 'titanzero.voltagent.telemetry';

export interface RunContext {
  companyId?: string;
  agentId?: string;
  runId?: string;
}

export interface ToolCallContext extends RunContext {
  toolId: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface SpanRecorder {
  /** Adds token counts. Other values are only accepted through the redaction allowlist. */
  setUsage(usage: Usage): void;
}

export interface TelemetryOptions {
  env?: NodeJS.ProcessEnv;
  /** Called only when the flag is on. The default is the global tracer from @opentelemetry/api. */
  createTracer?: () => Tracer;
  now?: () => number;
}

export interface Telemetry {
  readonly enabled: boolean;
  traceAgentRun<T>(
    context: RunContext,
    fn: (recorder: SpanRecorder) => Promise<T> | T
  ): Promise<T>;
  traceToolCall<T>(context: ToolCallContext, fn: () => Promise<T> | T): Promise<T>;
}

export const isTelemetryEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[TELEMETRY_FLAG] === 'true';

const noopRecorder: SpanRecorder = { setUsage: () => {} };

const usageAttributes = (usage: Usage): Record<string, unknown> => ({
  'gen_ai.usage.input_tokens': usage.inputTokens,
  'gen_ai.usage.output_tokens': usage.outputTokens,
});

const errorCodeOf = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'tool_error';
};

export const createTelemetry = (options: TelemetryOptions = {}): Telemetry => {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => performance.now());

  if (!isTelemetryEnabled(env)) {
    return {
      enabled: false,
      traceAgentRun: async (_context, fn) => fn(noopRecorder),
      traceToolCall: async (_context, fn) => fn(),
    };
  }

  const tracer = (options.createTracer ?? (() => trace.getTracer(TRACER_NAME)))();

  const runSpan = async <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span, start: number) => Promise<T> | T
  ): Promise<T> => {
    const span = tracer.startSpan(name);
    const safe: TelemetryAttributes = redactTelemetryAttributes(attributes);
    span.setAttributes(safe);
    const start = now();
    try {
      const result = await fn(span, start);
      span.setAttribute('titan.status', 'ok');
      return result;
    } catch (error) {
      span.setAttribute('titan.status', 'error');
      span.setAttribute('titan.error_code', errorCodeOf(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.setAttribute('titan.duration_ms', Math.round((now() - start) * 1000) / 1000);
      span.end();
    }
  };

  return {
    enabled: true,
    traceAgentRun: (context, fn) =>
      runSpan(
        AGENT_RUN_SPAN,
        {
          'titan.company_id': context.companyId,
          'titan.agent_id': context.agentId,
          'titan.run_id': context.runId,
        },
        (span) => {
          const recorder: SpanRecorder = {
            setUsage: (usage) => {
              span.setAttributes(redactTelemetryAttributes(usageAttributes(usage)));
            },
          };
          return fn(recorder);
        }
      ),
    traceToolCall: (context, fn) =>
      runSpan(
        TOOL_CALL_SPAN,
        {
          'titan.company_id': context.companyId,
          'titan.agent_id': context.agentId,
          'titan.run_id': context.runId,
          'titan.tool_id': context.toolId,
        },
        () => fn()
      ),
  };
};
