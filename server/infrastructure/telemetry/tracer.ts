/**
 * Telemetry wrapper for agent runs and tool calls.
 *
 * The tracer is injected. This module does not import @opentelemetry/api, so the
 * server boots without it. A real OpenTelemetry tracer is supplied by the caller
 * once VOLTAGENT_TELEMETRY_ENABLED is on. When telemetry is off, or no tracer is
 * given, every call is a no-op that still runs the wrapped function.
 */
import { redactAttributes, type SpanAttributes } from './redact.ts';

export interface TelemetrySpan {
  setAttributes(attrs: SpanAttributes): void;
  recordError(error: unknown): void;
  end(): void;
}

export interface TelemetryTracer {
  startSpan(name: string, attrs: SpanAttributes): TelemetrySpan;
}

export interface TelemetryOptions {
  enabled: boolean;
  tracer?: TelemetryTracer | null;
}

export interface Telemetry {
  readonly enabled: boolean;
  withSpan<T>(name: string, attrs: Record<string, unknown>, fn: (span: TelemetrySpan) => Promise<T> | T): Promise<T>;
}

const NOOP_SPAN: TelemetrySpan = { setAttributes() {}, recordError() {}, end() {} };

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const tracer = options.enabled ? options.tracer ?? null : null;
  const enabled = tracer !== null;
  return {
    enabled,
    async withSpan<T>(name: string, attrs: Record<string, unknown>, fn: (span: TelemetrySpan) => Promise<T> | T): Promise<T> {
      if (!tracer) return fn(NOOP_SPAN);
      const span = tracer.startSpan(name, redactAttributes(attrs));
      try {
        return await fn(span);
      } catch (error) {
        span.recordError(error);
        throw error;
      } finally {
        span.end();
      }
    },
  };
}
