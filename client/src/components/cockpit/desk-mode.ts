/**
 * The authenticated server returns "workforce" or "comms". Older deployments
 * used "syncedat" on the client; accept it as a compatibility alias only.
 */
export type DeskMode = "workforce" | "comms";

export const DESK_MODES: readonly DeskMode[] = ["workforce", "comms"];

export const DEFAULT_DESK_MODE: DeskMode = "workforce";

export function parseDeskMode(value: unknown): DeskMode | null {
  if (value === "syncedat") return "comms";
  if (value === "workforce" || value === "comms") return value;
  return null;
}
