export { redactAttributes, TELEMETRY_REDACTED, TELEMETRY_VALUE_MAX, type SpanAttributes, type SpanAttributeValue } from './redact.ts';
export { createTelemetry, type Telemetry, type TelemetryOptions, type TelemetrySpan, type TelemetryTracer } from './tracer.ts';
export { createOtelTelemetryTracer, OTEL_STATUS_ERROR, type OtelTraceApiLike, type OtelTracerLike, type OtelSpanLike } from './otel.ts';
