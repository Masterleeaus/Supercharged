/**
 * Director's Daily Briefing: one portfolio-level briefing built from records the caller injects.
 * Pure function. No database, network, timers or console output. The only clock is `input.now`.
 *
 * Rules the output keeps:
 *   - Eight sections, always in BRIEFING_SECTION_KEYS order.
 *   - Unknown health is counted separately and never added to healthy.
 *   - A run is reported as completed only when a verified 'succeeded' receipt exists for it.
 *   - Failed actions carry their failure reason, or 'no failure reason recorded'.
 *   - Support requests are overdue when their due time is before `input.now`.
 *   - Every item carries the id of its source record.
 *   - Records without a non-empty string id are excluded and the exclusion is stated in `notice`.
 *   - A section whose input array was not supplied is 'not_available'. An input with no rows is 'empty'.
 *     Neither shows counts, so zeros are never presented as verified.
 */
import type {
  BriefingInput,
  BriefingItem,
  BriefingSection,
  BriefingSectionKey,
  DirectorBriefing,
  HealthStatus,
} from './briefing-types.ts';
import { HEALTH_STATUSES } from './briefing-types.ts';

const FINISHED = new Set(['resolved', 'closed']);
const CRITICAL_CATEGORIES = new Set(['outage', 'security', 'data_integrity']);
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const TITLES: Record<BriefingSectionKey, string> = {
  portfolio_health: 'Portfolio Health',
  critical_exceptions: 'Critical Exceptions',
  approvals: 'Approvals',
  customer_support: 'Customer Support',
  customer_success: 'Customer Success',
  improvement_opportunities: 'Improvement Opportunities',
  workforce_performance: 'Workforce Performance',
  commercial_health: 'Commercial Health',
};

const INPUT_ARRAYS = [
  'health',
  'cases',
  'decisions',
  'receipts',
  'workforceRuns',
  'supportRequests',
  'setups',
  'improvements',
  'commercialFigures',
] as const;

type InputArrayName = (typeof INPUT_ARRAYS)[number];
type Body = { summary: string; counts: Record<string, number>; items: BriefingItem[] };
type Required = ReadonlyArray<readonly [string, readonly unknown[] | undefined]>;
type Due = { kind: 'none' } | { kind: 'invalid' } | { kind: 'valid'; ms: number };

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isFinished = (v: unknown): boolean => FINISHED.has(norm(v));
const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const iso = (ms: number): string => new Date(ms).toISOString();

function healthOf(v: unknown): HealthStatus {
  const n = norm(v);
  return (HEALTH_STATUSES as readonly string[]).includes(n) ? (n as HealthStatus) : 'unknown';
}

function parseDue(v: string | Date | null | undefined): Due {
  if (v === null || v === undefined || v === '') return { kind: 'none' };
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? { kind: 'valid', ms } : { kind: 'invalid' };
}

function priorityRank(v: unknown): number {
  return PRIORITY_RANK[norm(v)] ?? 4;
}

/** Keeps rows whose id is a non-empty string. Returns undefined when the input array was not supplied. */
function keepWithId<T extends { id?: unknown }>(
  name: InputArrayName,
  rows: readonly T[] | null | undefined,
  excluded: Partial<Record<InputArrayName, number>>,
): T[] | undefined {
  if (rows === null || rows === undefined) return undefined;
  const kept = rows.filter((r) => typeof r?.id === 'string' && r.id.trim() !== '');
  if (kept.length !== rows.length) excluded[name] = rows.length - kept.length;
  return kept;
}

/**
 * Wraps one section. If any input array is missing the section is 'not_available'. If every input array is
 * empty it is 'empty'. Otherwise the section body is built.
 */
function section(key: BriefingSectionKey, required: Required, emptyLabel: string, body: () => Body): BriefingSection {
  const title = TITLES[key];
  const missing = required.filter(([, rows]) => rows === undefined).map(([name]) => name);
  if (missing.length > 0) {
    return {
      key,
      title,
      state: 'not_available',
      summary: `Not available: no ${missing.join(', ')} input was supplied. Nothing is reported for this section.`,
      counts: {},
      items: [],
    };
  }
  const hasRows = required.some(([, rows]) => (rows as readonly unknown[]).length > 0);
  if (!hasRows) {
    return {
      key,
      title,
      state: 'empty',
      summary: `No ${emptyLabel} records supplied. Nothing is verified for this section.`,
      counts: {},
      items: [],
    };
  }
  const b = body();
  return { key, title, state: 'populated', summary: b.summary, counts: b.counts, items: b.items };
}

/** Builds the Director's Daily Briefing. Throws TypeError when `input.now` is not a valid Date. */
export function buildDirectorBriefing(input: BriefingInput): DirectorBriefing {
  if (!(input?.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new TypeError('invalid_clock: now must be a valid Date');
  }
  const nowMs = input.now.getTime();
  const excluded: Partial<Record<InputArrayName, number>> = {};

  const s: BriefingInput = {
    now: input.now,
    health: keepWithId('health', input.health, excluded),
    cases: keepWithId('cases', input.cases, excluded),
    decisions: keepWithId('decisions', input.decisions, excluded),
    receipts: keepWithId('receipts', input.receipts, excluded),
    workforceRuns: keepWithId('workforceRuns', input.workforceRuns, excluded),
    supportRequests: keepWithId('supportRequests', input.supportRequests, excluded),
    setups: keepWithId('setups', input.setups, excluded),
    improvements: keepWithId('improvements', input.improvements, excluded),
    commercialFigures: keepWithId('commercialFigures', input.commercialFigures, excluded),
  };

  const sections: BriefingSection[] = [
    section('portfolio_health', [['health', s.health]], 'health', () => {
      const rows = s.health ?? [];
      const counts = { total: rows.length, healthy: 0, degraded: 0, unavailable: 0, unknown: 0 };
      const items: BriefingItem[] = [];
      for (const r of rows) {
        const st = healthOf(r.status);
        counts[st] += 1;
        if (st !== 'healthy') {
          items.push({
            recordId: r.id,
            text: `System status: ${st}`,
            flag: st,
            detail: clean(r.reason) || (st === 'unknown' ? 'No current status; not counted as healthy' : undefined),
          });
        }
      }
      const rank = { unavailable: 0, degraded: 1, unknown: 2 } as Record<string, number>;
      items.sort((a, b) => rank[a.flag ?? ''] - rank[b.flag ?? '']);
      return {
        summary: `${counts.total} system(s): ${counts.healthy} healthy, ${counts.degraded} degraded, ${counts.unavailable} unavailable, ${counts.unknown} unknown. Unknown systems are not counted as healthy.`,
        counts,
        items,
      };
    }),

    section('critical_exceptions', [['cases', s.cases]], 'case', () => {
      const rows = s.cases ?? [];
      const active = rows.filter((c) => !isFinished(c.state));
      const critical = active.filter(
        (c) => norm(c.severity) === 'critical' || CRITICAL_CATEGORIES.has(norm(c.category)),
      );
      return {
        summary:
          critical.length > 0
            ? `${critical.length} critical exception(s) among ${active.length} active case(s).`
            : `No critical exceptions among ${active.length} active case(s) of ${rows.length} supplied.`,
        counts: { critical: critical.length, active: active.length, total: rows.length },
        items: critical.map((c) => ({
          recordId: c.id,
          text: clean(c.title) || 'Untitled case',
          flag: 'critical',
          detail: `${norm(c.category) || norm(c.severity) || 'uncategorised'} · ${norm(c.state) || 'state not stated'}`,
        })),
      };
    }),

    section('approvals', [['decisions', s.decisions]], 'decision', () => {
      const rows = s.decisions ?? [];
      const waiting = rows
        .filter((d) => norm(d.status) === 'awaiting_approval')
        .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
      return {
        summary: `${waiting.length} decision(s) awaiting approval. Listing a decision does not approve it.`,
        counts: { awaiting: waiting.length, total: rows.length },
        items: waiting.map((d) => ({
          recordId: d.id,
          text: clean(d.issue) || 'Decision awaiting approval',
          detail: `Priority ${norm(d.priority) || 'not stated'}; approval authority: ${clean(d.approvalAuthority) || 'not stated'}`,
        })),
      };
    }),

    section('customer_support', [['supportRequests', s.supportRequests]], 'support request', () => {
      const rows = s.supportRequests ?? [];
      const open = rows
        .filter((r) => !isFinished(r.status))
        .map((r) => ({ r, due: parseDue(r.dueAt) }));
      const order = (x: (typeof open)[number]): [number, number] => {
        if (x.due.kind === 'valid') return x.due.ms < nowMs ? [0, x.due.ms] : [2, x.due.ms];
        if (x.due.kind === 'invalid') return [1, 0];
        return [3, 0];
      };
      open.sort((a, b) => {
        const [ga, ta] = order(a);
        const [gb, tb] = order(b);
        return ga - gb || ta - tb;
      });
      const overdue = open.filter((x) => x.due.kind === 'valid' && x.due.ms < nowMs).length;
      const dueUnreadable = open.filter((x) => x.due.kind === 'invalid').length;
      return {
        summary: `${open.length} unresolved request(s); ${overdue} overdue as of ${iso(nowMs)}.${dueUnreadable ? ` ${dueUnreadable} with an unreadable due time are flagged unknown, not overdue.` : ''}`,
        counts: { unresolved: open.length, overdue, dueUnreadable, total: rows.length },
        items: open.map(({ r, due }) => {
          const isOverdue = due.kind === 'valid' && due.ms < nowMs;
          return {
            recordId: r.id,
            text: clean(r.title) || 'Untitled request',
            flag: isOverdue ? 'overdue' : due.kind === 'invalid' ? 'unknown' : undefined,
            detail:
              due.kind === 'valid'
                ? `Due ${iso(due.ms)}${isOverdue ? `; overdue as of ${iso(nowMs)}` : ''}`
                : due.kind === 'invalid'
                  ? 'Due time unreadable'
                  : 'No due time set',
          };
        }),
      };
    }),

    section('customer_success', [['setups', s.setups]], 'setup', () => {
      const rows = s.setups ?? [];
      const counts = { total: rows.length, complete: 0, incomplete: 0, unknown: 0, serviceConcerns: 0 };
      const items: BriefingItem[] = [];
      for (const r of rows) {
        if (r.setupComplete === true) counts.complete += 1;
        else if (r.setupComplete === false) counts.incomplete += 1;
        else counts.unknown += 1;
        const concern = clean(r.serviceConcern);
        if (concern) counts.serviceConcerns += 1;
        if (r.setupComplete === true && !concern) continue;
        const flag = concern ? 'service_concern' : r.setupComplete === false ? 'incomplete' : 'unknown';
        items.push({
          recordId: r.id,
          text: r.setupComplete === true ? 'Setup complete' : r.setupComplete === false ? 'Setup incomplete' : 'Setup status unknown',
          flag,
          detail: concern ? `Service concern: ${concern}` : undefined,
        });
      }
      return {
        summary: `${counts.complete} of ${counts.total} setup(s) complete; ${counts.incomplete} incomplete; ${counts.unknown} unknown (not counted as complete). ${counts.serviceConcerns} service concern(s).`,
        counts,
        items,
      };
    }),

    section('improvement_opportunities', [['improvements', s.improvements]], 'improvement', () => {
      const rows = s.improvements ?? [];
      return {
        summary: `${rows.length} improvement suggestion(s). These are suggestions only; none has been actioned.`,
        counts: { total: rows.length },
        items: rows.map((r) => ({
          recordId: r.id,
          text: clean(r.title) || 'Untitled suggestion',
          detail: clean(r.category) || 'category not stated',
        })),
      };
    }),

    section(
      'workforce_performance',
      [
        ['receipts', s.receipts],
        ['workforceRuns', s.workforceRuns],
      ],
      'receipt or workforce run',
      () => {
        const receipts = s.receipts ?? [];
        const runs = s.workforceRuns ?? [];
        const verifiedSuccess = receipts.filter((r) => norm(r.outcome) === 'succeeded' && r.verified === true);
        const unverifiedSuccess = receipts.filter((r) => norm(r.outcome) === 'succeeded' && r.verified !== true);
        const failedReceipts = receipts.filter((r) => norm(r.outcome) === 'failed');
        const verifiedRunIds = new Set(verifiedSuccess.map((r) => r.runId));
        const failedRunIds = new Set(failedReceipts.map((r) => r.runId));
        const failedRuns = runs.filter((r) => norm(r.status) === 'failed' && !failedRunIds.has(r.id));
        const unverifiedRuns = runs.filter((r) => norm(r.status) === 'completed' && !verifiedRunIds.has(r.id));
        const retried = runs.filter((r) => norm(r.status) === 'retried');
        const escalated = runs.filter((r) => norm(r.status) === 'escalated');

        const reasonOf = (reason: unknown) => `Reason: ${clean(reason) || 'no failure reason recorded'}`;
        const items: BriefingItem[] = [
          ...failedReceipts.map((r) => ({ recordId: r.id, text: 'Action failed', flag: 'failed', detail: reasonOf(r.reason) })),
          ...failedRuns.map((r) => ({ recordId: r.id, text: 'Run failed', flag: 'failed', detail: reasonOf(r.reason) })),
          ...escalated.map((r) => ({ recordId: r.id, text: 'Escalated', flag: 'escalated', detail: clean(r.reason) || undefined })),
          ...retried.map((r) => ({ recordId: r.id, text: 'Retried', flag: 'retried', detail: clean(r.reason) || undefined })),
          ...unverifiedSuccess.map((r) => ({
            recordId: r.id,
            text: 'Success not verified; not counted as completed',
            flag: 'not_verified',
          })),
          ...unverifiedRuns.map((r) => ({
            recordId: r.id,
            text: 'Marked completed without a verified receipt; not counted as completed',
            flag: 'not_verified',
          })),
          ...verifiedSuccess.map((r) => ({ recordId: r.id, text: 'Action completed (verified receipt)' })),
        ];

        const counts = {
          completed: verifiedSuccess.length,
          failed: failedReceipts.length + failedRuns.length,
          retried: retried.length,
          escalated: escalated.length,
          notVerified: unverifiedSuccess.length + unverifiedRuns.length,
        };
        return {
          summary: `Completed with verified receipt: ${counts.completed}. Failed: ${counts.failed}. Retried: ${counts.retried}. Escalated: ${counts.escalated}. Not verified (not counted as completed): ${counts.notVerified}.`,
          counts,
          items,
        };
      },
    ),

    section('commercial_health', [['commercialFigures', s.commercialFigures]], 'commercial figure', () => {
      const rows = s.commercialFigures ?? [];
      const items: BriefingItem[] = rows.map((f) => {
        const risk = clean(f.risk);
        const missingValue = f.value === null || f.value === undefined;
        return {
          recordId: f.id,
          text: `${clean(f.label) || 'Figure'}: ${missingValue ? 'not available' : String(f.value)}`,
          flag: risk ? 'risk' : missingValue ? 'unknown' : undefined,
          detail: risk || (missingValue ? 'Value not available' : undefined),
        };
      });
      const rank = { risk: 0, unknown: 1 } as Record<string, number>;
      items.sort((a, b) => (rank[a.flag ?? ''] ?? 2) - (rank[b.flag ?? ''] ?? 2));
      const risks = items.filter((i) => i.flag === 'risk').length;
      const unknown = items.filter((i) => i.flag === 'unknown').length;
      return {
        summary: `${rows.length} figure(s): ${risks} with a reported risk, ${unknown} without a value.`,
        counts: { figures: rows.length, risks, unknown },
        items,
      };
    }),
  ];

  const isEmpty = INPUT_ARRAYS.every((name) => (s[name] ?? []).length === 0);
  const notAvailable = sections.filter((x) => x.state === 'not_available').map((x) => x.title);
  const parts: string[] = [];
  if (isEmpty) {
    parts.push(
      'Empty input: no records were supplied. Nothing in this briefing is verified. Sections are labelled empty or not available, and no counts are shown.',
    );
  }
  if (notAvailable.length > 0) {
    parts.push(`Not available from current data: ${notAvailable.join(', ')}.`);
  }
  const excludedNames = INPUT_ARRAYS.filter((name) => (excluded[name] ?? 0) > 0);
  if (excludedNames.length > 0) {
    const total = excludedNames.reduce((n, name) => n + (excluded[name] ?? 0), 0);
    parts.push(`${total} record(s) without a usable id were excluded.`);
  }

  return {
    generatedAt: iso(nowMs),
    isEmpty,
    notice: parts.length > 0 ? parts.join(' ') : null,
    sections,
  };
}
