// Per-company follow-up schedule overrides (#361). Stores only schedules that pass parseSchedule.
// Missing company overrides fall back to DEFAULT_SCHEDULES. A rejected save changes nothing.
// Decision (2026-11-18): the store is a port with an in-memory adapter. No admin route is added
// here, because route allowlists and auth guards are owner-controlled.

import {
  DEFAULT_SCHEDULES,
  FOLLOW_UP_KINDS,
  parseSchedule,
  type FollowUpKind,
  type FollowUpSchedule,
} from './follow-up-schedule.ts';

export interface ScheduleOverrideStore {
  get(companyId: string, kind: FollowUpKind): Promise<FollowUpSchedule | null>;
  put(companyId: string, schedule: FollowUpSchedule): Promise<void>;
}

export type SaveScheduleResult =
  | { ok: true; schedule: FollowUpSchedule }
  | { ok: false; errors: string[] };

export function createMemoryScheduleStore(): ScheduleOverrideStore {
  const data = new Map<string, FollowUpSchedule>();
  const key = (companyId: string, kind: FollowUpKind) => `${companyId}:${kind}`;
  return {
    async get(companyId, kind) {
      const found = data.get(key(companyId, kind));
      return found ? structuredClone(found) : null;
    },
    async put(companyId, schedule) {
      data.set(key(companyId, schedule.kind), structuredClone(schedule));
    },
  };
}

export async function saveScheduleOverride(
  store: ScheduleOverrideStore,
  companyId: string,
  kind: FollowUpKind,
  raw: unknown,
): Promise<SaveScheduleResult> {
  if (!companyId) return { ok: false, errors: ['companyId is required'] };
  const parsed = parseSchedule(kind, raw);
  if (!parsed.ok) return parsed;
  await store.put(companyId, parsed.schedule);
  return { ok: true, schedule: parsed.schedule };
}

export async function loadSchedules(
  store: ScheduleOverrideStore,
  companyId: string,
): Promise<Record<FollowUpKind, FollowUpSchedule>> {
  const out = structuredClone(DEFAULT_SCHEDULES);
  for (const kind of FOLLOW_UP_KINDS) {
    const override = await store.get(companyId, kind);
    if (override) out[kind] = override;
  }
  return out;
}
