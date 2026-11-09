import type { ProductMode, ServerDeskMode } from "./desk-product-mode.ts";

export interface ModeFlags { inbox: boolean; marketing: boolean }
export type ModeAvailability =
  | { available: true }
  | { available: false; reason: "mode_unavailable" | "feature_disabled" | "mode_unknown" };

export function modeAvailability(
  selected: ProductMode,
  serverMode: ServerDeskMode | null,
  flags: ModeFlags,
): ModeAvailability {
  if (!serverMode) return { available: false, reason: "mode_unknown" };
  if (serverMode !== "comms") return { available: false, reason: "mode_unavailable" };
  if (selected === "inbox" && !flags.inbox) return { available: false, reason: "feature_disabled" };
  if (selected === "marketing" && !flags.marketing) return { available: false, reason: "feature_disabled" };
  return { available: true };
}
export const MODE_UNAVAILABLE_TEXT: Record<Exclude<ModeAvailability, {available: true}>["reason"], string> = {
  mode_unknown: "The authenticated server mode and host could not be verified. No mode-specific tools are available.",
  mode_unavailable: "This workspace is served from the workforce host. Open your authorized communications workspace to access this mode.",
  feature_disabled: "This capability is disabled in this deployment. Ask an administrator to enable its server routes and matching client flag.",
};
