/**
 * Pure helpers for the read-only run history list.
 * No imports, no side effects, so tests can load this file directly.
 */

export interface RunHistoryItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  createdAt: string | null;
}

const KIND_LABELS: Record<string, string> = {
  completed: "Completed",
  needs_approval: "Needs approval",
  run_needs_attention: "Needs attention",
  activity: "Activity",
};

/** Human label for an item kind. Known kinds get fixed labels; others are title-cased from snake_case. */
export function kindLabel(kind: string): string {
  const key = kind.trim();
  if (key === "") return KIND_LABELS.activity;
  if (Object.prototype.hasOwnProperty.call(KIND_LABELS, key)) return KIND_LABELS[key];
  const words = key.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function timeOf(item: RunHistoryItem): number | null {
  if (item.createdAt === null) return null;
  const ms = Date.parse(item.createdAt);
  return Number.isNaN(ms) ? null : ms;
}

/** Newest first. Items with no valid time go last. Returns a new array; the input is not changed. */
export function sortRunHistory(items: readonly RunHistoryItem[]): RunHistoryItem[] {
  return [...items].sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  });
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** Keeps rows that have a string id and maps the rest to safe display fields. Unusable rows are dropped. */
export function toRunHistoryItems(rows: unknown): RunHistoryItem[] {
  if (!Array.isArray(rows)) return [];
  const out: RunHistoryItem[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "") continue;
    const kind = text(r.kind, "activity");
    out.push({
      id: r.id,
      kind,
      title: text(r.title, kindLabel(kind)),
      detail: text(r.detail, "No detail"),
      createdAt: typeof r.createdAt === "string" && r.createdAt !== "" ? r.createdAt : null,
    });
  }
  return out;
}
