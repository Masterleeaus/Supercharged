/**
 * Desk mode for the dashboard cockpit.
 *
 * GET /api/desk-mode returns { mode }, where mode is "workforce" (SuperchargedAt.Work)
 * or "syncedat" (SyncedAt.Work). The server decides the mode from the request host.
 * When the request fails or returns no valid mode, the cockpit uses DEFAULT_DESK_MODE
 * and shows a notice (see resolveDeskMode in cockpit-logic.ts).
 */
export type DeskMode = "workforce" | "syncedat";

export const DESK_MODES: readonly DeskMode[] = ["workforce", "syncedat"];

export const DEFAULT_DESK_MODE: DeskMode = "workforce";

/** Returns the mode when the value is a known mode name, otherwise null. */
export function parseDeskMode(value: unknown): DeskMode | null {
  if (typeof value !== "string") return null;
  return (DESK_MODES as readonly string[]).includes(value) ? (value as DeskMode) : null;
}
