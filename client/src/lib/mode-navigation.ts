import { productModeForPath, type ProductMode } from "./desk-product-mode.ts";

export interface ModeDestination {
  id: ProductMode;
  label: string;
  description: string;
  href: string;
}
export const MODE_DESTINATIONS: readonly ModeDestination[] = [
  { id: "marketing", label: "Marketing", description: "Campaigns, audiences and responses", href: "/app/modes/marketing" },
  { id: "inbox", label: "Omnichannel Inbox", description: "Customer conversations and handover", href: "/app/modes/inbox" },
];
export function destinationForMode(mode: ProductMode): ModeDestination {
  const found = MODE_DESTINATIONS.find((entry) => entry.id === mode);
  if (!found) throw new Error("Unknown product mode");
  return found;
}
export function selectedMode(pathname: string): ProductMode | null {
  return productModeForPath(pathname.split(/[?#]/, 1)[0]);
}

/** Selection comes from the route, never a company query parameter. */
export function destinationForPath(pathname: string): ModeDestination | null {
  const mode = selectedMode(pathname);
  return mode ? destinationForMode(mode) : null;
}
