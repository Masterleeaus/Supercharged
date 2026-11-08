/**
 * Maps the retired autonomy values onto the current four tiers: assist, suggest, auto, predictive.
 *
 * Owner mapping (decided):
 *   observe_only        -> assist
 *   recommend_only      -> suggest
 *   prepare_only        -> suggest
 *   approval_required   -> auto
 *   delegated_autonomous -> auto
 *
 * Predictive is never assigned by this migration. A current value maps to itself.
 * Pure functions only: no database, no I/O. migrateRecord never mutates its input.
 */

export const AUTONOMY_TIERS = ['assist', 'suggest', 'auto', 'predictive'] as const;
export type AutonomyTier = (typeof AUTONOMY_TIERS)[number];

export const LEGACY_AUTONOMY_MAP: Readonly<Record<string, AutonomyTier>> = Object.freeze({
  observe_only: 'assist',
  recommend_only: 'suggest',
  prepare_only: 'suggest',
  approval_required: 'auto',
  delegated_autonomous: 'auto',
});

export type MigrateAutonomyResult =
  | { ok: true; value: AutonomyTier }
  | { ok: false; reason: 'unknown_value' };

const CURRENT = new Set<string>(AUTONOMY_TIERS);

function isOwn(map: Readonly<Record<string, AutonomyTier>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** Migrate one autonomy value. Unknown or non-string input is refused, never guessed. */
export function migrateAutonomy(value: unknown): MigrateAutonomyResult {
  if (typeof value !== 'string') return { ok: false, reason: 'unknown_value' };
  if (CURRENT.has(value)) return { ok: true, value: value as AutonomyTier };
  if (isOwn(LEGACY_AUTONOMY_MAP, value)) return { ok: true, value: LEGACY_AUTONOMY_MAP[value] };
  return { ok: false, reason: 'unknown_value' };
}

/**
 * Return a new record with autonomy migrated. The input is left untouched.
 * Throws a TypeError carrying reason 'unknown_value' when autonomy cannot be migrated.
 */
export function migrateRecord<T extends { autonomy: unknown }>(record: T): T & { autonomy: AutonomyTier } {
  const result = migrateAutonomy(record.autonomy);
  if (!result.ok) {
    const error = new TypeError(`unknown autonomy value: ${String(record.autonomy)}`);
    (error as TypeError & { reason: string }).reason = result.reason;
    throw error;
  }
  return { ...record, autonomy: result.value };
}
