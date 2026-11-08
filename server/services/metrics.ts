/**
 * Prometheus-style metrics registry for Desk.
 *
 * Fails closed: if prom-client cannot be loaded, every recorder becomes a
 * no-op, /metrics renders an empty body, and a single warning is logged.
 * Metric calls never throw into the request path.
 */
import { createRequire } from 'node:module';

export type MetricLabels = Record<string, string>;

export interface CounterHandle {
  inc(labels?: MetricLabels, value?: number): void;
}

export interface HistogramHandle {
  observe(labels: MetricLabels, value: number): void;
}

export interface HttpRequestSample {
  method: string;
  /** Route pattern such as /api/users/:id, never the raw URL. */
  route: string;
  /** Status class such as 2xx, or "aborted" when the client disconnected. */
  statusClass: string;
  durationSeconds: number;
}

export interface MetricsRecorder {
  readonly enabled: boolean;
  counter(name: string, help: string, labelNames?: string[]): CounterHandle;
  histogram(name: string, help: string, labelNames?: string[], buckets?: number[]): HistogramHandle;
  observeHttpRequest(sample: HttpRequestSample): void;
  contentType(): string;
  render(): Promise<string>;
}

// Minimal structural types so this file compiles even before prom-client is installed.
interface PromCollector { inc(labels?: MetricLabels, value?: number): void; observe?(labels: MetricLabels, value: number): void; }
interface PromRegistry { metrics(): Promise<string>; contentType: string; }
export interface PromClientModule {
  Registry: new () => PromRegistry;
  Counter: new (config: Record<string, unknown>) => PromCollector;
  Histogram: new (config: Record<string, unknown>) => PromCollector;
  collectDefaultMetrics?: (config: { register: PromRegistry }) => void;
}

export type PromClientLoader = () => PromClientModule;

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
export const HTTP_REQUESTS_METRIC = 'desk_http_requests_total';
export const HTTP_DURATION_METRIC = 'desk_http_request_duration_seconds';
const HTTP_LABELS = ['method', 'route', 'status_class'];
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

let warnedOnce = false;

function warnOnce(reason: string, logger: Pick<Console, 'warn'>): void {
  if (warnedOnce) return;
  warnedOnce = true;
  logger.warn(`[metrics] prom-client unavailable, metrics disabled: ${reason}`);
}

const defaultLoader: PromClientLoader = () => {
  const require = createRequire(import.meta.url);
  return require('prom-client') as PromClientModule;
};

const noopHandle: CounterHandle & HistogramHandle = {
  inc() {},
  observe() {},
};

export function createNoopRecorder(): MetricsRecorder {
  return {
    enabled: false,
    counter: () => noopHandle,
    histogram: () => noopHandle,
    observeHttpRequest() {},
    contentType: () => PROMETHEUS_CONTENT_TYPE,
    async render() {
      return '';
    },
  };
}

export interface CreateMetricsRecorderOptions {
  loadPromClient?: PromClientLoader;
  logger?: Pick<Console, 'warn'>;
}

export function createMetricsRecorder(options: CreateMetricsRecorderOptions = {}): MetricsRecorder {
  const logger = options.logger ?? console;
  let prom: PromClientModule;
  try {
    prom = (options.loadPromClient ?? defaultLoader)();
    if (!prom || typeof prom.Registry !== 'function') {
      throw new Error('module did not export Registry');
    }
  } catch (err) {
    warnOnce(err instanceof Error ? err.message : String(err), logger);
    return createNoopRecorder();
  }

  try {
    return buildPromRecorder(prom, logger);
  } catch (err) {
    warnOnce(err instanceof Error ? err.message : String(err), logger);
    return createNoopRecorder();
  }
}

function buildPromRecorder(prom: PromClientModule, logger: Pick<Console, 'warn'>): MetricsRecorder {
  const registry = new prom.Registry();
  if (typeof prom.collectDefaultMetrics === 'function') {
    try {
      prom.collectDefaultMetrics({ register: registry });
    } catch (err) {
      logger.warn(`[metrics] default process metrics unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // One collector per metric name; repeated calls return the same handle.
  const collectors = new Map<string, CounterHandle & HistogramHandle>();

  const safe = <T extends (...args: any[]) => void>(fn: T): T =>
    ((...args: any[]) => {
      try {
        fn(...args);
      } catch (err) {
        logger.warn(`[metrics] record failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }) as T;

  const makeCounter = (name: string, help: string, labelNames: string[]): CounterHandle => {
    const existing = collectors.get(name);
    if (existing) return existing;
    const collector = new prom.Counter({ name, help, labelNames, registers: [registry] });
    const handle = {
      inc: safe((labels: MetricLabels = {}, value = 1) => collector.inc(labels, value)),
      observe: noopHandle.observe,
    };
    collectors.set(name, handle);
    return handle;
  };

  const makeHistogram = (name: string, help: string, labelNames: string[], buckets?: number[]): HistogramHandle => {
    const existing = collectors.get(name);
    if (existing) return existing;
    const collector = new prom.Histogram({ name, help, labelNames, buckets, registers: [registry] });
    const handle = {
      inc: noopHandle.inc,
      observe: safe((labels: MetricLabels, value: number) => collector.observe?.(labels, value)),
    };
    collectors.set(name, handle);
    return handle;
  };

  const httpRequests = makeCounter(HTTP_REQUESTS_METRIC, 'Total HTTP requests handled', HTTP_LABELS);
  const httpDuration = makeHistogram(
    HTTP_DURATION_METRIC,
    'HTTP request duration in seconds',
    HTTP_LABELS,
    HTTP_BUCKETS,
  );

  return {
    enabled: true,
    counter(name, help, labelNames = []) {
      return makeCounter(name, help, labelNames);
    },
    histogram(name, help, labelNames = [], buckets) {
      return makeHistogram(name, help, labelNames, buckets);
    },
    observeHttpRequest(sample) {
      const labels = {
        method: sample.method,
        route: sample.route,
        status_class: sample.statusClass,
      };
      httpRequests.inc(labels);
      httpDuration.observe(labels, sample.durationSeconds);
    },
    contentType: () => registry.contentType,
    render: () => registry.metrics(),
  };
}

let defaultRecorder: MetricsRecorder | undefined;

/** Process-wide recorder, created on first use. */
export function getDefaultMetrics(): MetricsRecorder {
  defaultRecorder ??= createMetricsRecorder();
  return defaultRecorder;
}

/** Inject a recorder (tests) or reset with undefined. */
export function setDefaultMetrics(recorder: MetricsRecorder | undefined): void {
  defaultRecorder = recorder;
}

/** Test hook: clears the warn-once flag. */
export function resetMetricsWarningForTests(): void {
  warnedOnce = false;
}
