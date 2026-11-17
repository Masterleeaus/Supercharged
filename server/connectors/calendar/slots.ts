/**
 * Availability for a job type, with buffer and travel time (#354). A job blocks its own time plus travel
 * before and after, plus a buffer before and after. A candidate start is offered only when that whole footprint
 * avoids every busy interval. Pure: no I/O.
 */
export interface Interval {
  start: number;
  end: number;
}

export interface JobProfile {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  travelBeforeMin: number;
  travelAfterMin: number;
}

export interface FreeSlotInput {
  windowStart: number;
  windowEnd: number;
  busy: Interval[];
  job: JobProfile;
  /** Gap between candidate starts. Default 15 minutes. */
  stepMin?: number;
}

const MIN = 60_000;

function assertProfile(job: JobProfile): void {
  const fields = [job.durationMin, job.bufferBeforeMin, job.bufferAfterMin, job.travelBeforeMin, job.travelAfterMin];
  if (fields.some((v) => !Number.isFinite(v) || v < 0)) throw new RangeError('job profile values must be finite and non-negative');
  if (job.durationMin <= 0) throw new RangeError('job duration must be positive');
}

/** The time a job occupies on the calendar, including travel and buffers on both sides. */
export function footprint(start: number, job: JobProfile): Interval {
  const before = (job.travelBeforeMin + job.bufferBeforeMin) * MIN;
  const after = (job.travelAfterMin + job.bufferAfterMin) * MIN;
  return { start: start - before, end: start + job.durationMin * MIN + after };
}

export function freeSlots(input: FreeSlotInput): Interval[] {
  assertProfile(input.job);
  const step = (input.stepMin ?? 15) * MIN;
  if (!(step > 0)) throw new RangeError('stepMin must be positive');
  const duration = input.job.durationMin * MIN;
  const out: Interval[] = [];
  for (let start = input.windowStart; start + duration <= input.windowEnd; start += step) {
    const fp = footprint(start, input.job);
    const clear = input.busy.every((b) => !(fp.start < b.end && b.start < fp.end));
    if (clear) out.push({ start, end: start + duration });
  }
  return out;
}
