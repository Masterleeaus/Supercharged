/**
 * Health report and metrics registry. Port of HealthCheckService.php and Support/Metrics.php.
 *
 * Secret rule: the report is built only from booleans, fixed codes and the version string. The PHP put the
 * raw exception message into the report. That message can carry a DSN or password, so this port
 * reports the fixed code "database_unreachable" and drops the message.
 * Nothing in this file receives a key, token or connection string.
 */

/** Tables this slice needs. Names follow the Desk schema, not the PHP ext_chatbot_* names. */
export const HEALTH_REQUIRED_TABLES: readonly string[] = ["chatbot_conversations", "chatbot_messages", "chatbot_attachments"];

export const HEALTH_REQUIRED_COLUMNS: readonly { table: string; column: string }[] = [
  { table: "chatbot_attachments", column: "sha256" },
  { table: "chatbot_attachments", column: "deleted_at" },
  { table: "chatbot_messages", column: "is_internal_note" },
];

export interface HealthProbes {
  /** Resolves when the database answers. Any rejection means the database is unreachable. */
  ping(): Promise<void>;
  hasTable(table: string): Promise<boolean>;
  hasColumn(table: string, column: string): Promise<boolean>;
}

export interface HealthReport {
  ok: boolean;
  extension: "chatbot";
  version: string;
  checks: {
    database: boolean;
    runtime_enabled: boolean;
    tables: Record<string, boolean>;
    columns: Record<string, boolean>;
    error?: "database_unreachable";
  };
  timestamp: string;
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.\-]{0,31}$/;

export async function buildHealthReport(input: {
  probes: HealthProbes;
  /** The caller reads the runtime flag with readFlag and passes the result in. */
  runtimeEnabled: boolean;
  version: string;
  now: Date;
  tables?: readonly string[];
  columns?: readonly { table: string; column: string }[];
}): Promise<HealthReport> {
  const version = VERSION_PATTERN.test(input.version) ? input.version : "unknown";
  const tables: Record<string, boolean> = {};
  const columns: Record<string, boolean> = {};
  const checks: HealthReport["checks"] = {
    database: false,
    runtime_enabled: input.runtimeEnabled,
    tables,
    columns,
  };

  try {
    await input.probes.ping();
    checks.database = true;
  } catch {
    checks.error = "database_unreachable";
  }

  if (checks.database) {
    for (const table of input.tables ?? HEALTH_REQUIRED_TABLES) {
      tables[table] = await safely(() => input.probes.hasTable(table));
    }
    for (const { table, column } of input.columns ?? HEALTH_REQUIRED_COLUMNS) {
      columns[`${table}.${column}`] = await safely(() => input.probes.hasColumn(table, column));
    }
  }

  const ok =
    checks.database &&
    checks.runtime_enabled &&
    Object.values(tables).every(Boolean) &&
    Object.values(columns).every(Boolean);

  return { ok, extension: "chatbot", version, checks, timestamp: input.now.toISOString() };
}

/** A failing schema probe counts as a missing table or column. Its message is not kept. */
async function safely(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await probe()) === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const METRIC_NAME = /^chatbot\.[a-z0-9_.]{1,64}$/;
const TAG_KEYS: ReadonlySet<string> = new Set(["outcome", "format", "kind", "status_class"]);
const TAG_VALUE = /^[a-z0-9_]{1,32}$/;

export type MetricTags = Readonly<Record<string, string>>;

export interface TimingSummary {
  count: number;
  sum: number;
  max: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  timings: Record<string, TimingSummary>;
}

/**
 * In-memory counters and timings. Names must start with "chatbot.". Only the tag keys in TAG_KEYS are kept, and
 * only values made of lower-case letters, digits and underscores. Anything else is dropped, so a token or a URL
 * cannot be written into a metric series by mistake.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, TimingSummary>();

  increment(name: string, tags: MetricTags = {}): void {
    const key = seriesKey(name, tags);
    if (key === null) return;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  timing(name: string, milliseconds: number, tags: MetricTags = {}): void {
    const key = seriesKey(name, tags);
    if (key === null || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    const current = this.timings.get(key) ?? { count: 0, sum: 0, max: 0 };
    this.timings.set(key, {
      count: current.count + 1,
      sum: current.sum + milliseconds,
      max: Math.max(current.max, milliseconds),
    });
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(this.timings),
    };
  }
}

function seriesKey(name: string, tags: MetricTags): string | null {
  if (!METRIC_NAME.test(name)) return null;
  const kept = Object.keys(tags)
    .filter((key) => TAG_KEYS.has(key) && TAG_VALUE.test(tags[key] ?? ""))
    .sort()
    .map((key) => `${key}=${tags[key]}`);
  return kept.length > 0 ? `${name}{${kept.join(",")}}` : name;
}
