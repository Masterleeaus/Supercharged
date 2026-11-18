/**
 * OpenTelemetry adapter for the telemetry wrapper (issue #381).
 *
 * Maps the wrapper's TelemetryTracer onto an OpenTelemetry-shaped tracer. The caller passes in
 * `trace` from @opentelemetry/api, so this module never imports it and the server boots without it.
 *
 * Version: the root lockfile pins @opentelemetry/api 1.9.1. @voltagent/core 2.11.1 requires
 * '^1.9.0' (checked in package-lock.json), so 1.9.1 satisfies the peer range.
 *
 * Exceptions: the message is passed through the same string redaction as attributes, and the stack
 * is never recorded, because a stack can carry argument text.
 */
import { redactString } from '../../services/redaction.ts';
import { redactAttributes, TELEMETRY_REDACTED, type SpanAttributes } from './redact.ts';
import type { TelemetrySpan, TelemetryTracer } from './tracer.ts';

/** Structural subset of @opentelemetry/api used here. */
export interface OtelSpanLike {
  setAttributes(attrs: SpanAttributes): unknown;
  recordException(exception: { name: string; message: string }): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): unknown;
}

export interface OtelTracerLike {
  startSpan(name: string, options?: { attributes?: SpanAttributes }): OtelSpanLike;
}

export interface OtelTraceApiLike {
  trace: { getTracer(name: string, version?: string): OtelTracerLike };
}

/** Value of SpanStatusCode.ERROR in @opentelemetry/api. */
export const OTEL_STATUS_ERROR = 2;

export function createOtelTelemetryTracer(api: OtelTraceApiLike, instrumentationName = 'titanzero'): TelemetryTracer {
  const tracer = api.trace.getTracer(instrumentationName);
  return {
    startSpan(name: string, attrs: SpanAttributes): TelemetrySpan {
      const span = tracer.startSpan(name, { attributes: redactAttributes(attrs) });
      return {
        setAttributes(more: SpanAttributes) {
          span.setAttributes(redactAttributes(more));
        },
        recordError(error: unknown) {
          const raw = error instanceof Error ? error : null;
          const name = raw ? raw.name : 'Error';
          const message = raw ? redactString(raw.message, TELEMETRY_REDACTED).text : TELEMETRY_REDACTED;
          span.recordException({ name, message });
          span.setStatus({ code: OTEL_STATUS_ERROR, message: name });
        },
        end() {
          span.end();
        },
      };
    },
  };
}
