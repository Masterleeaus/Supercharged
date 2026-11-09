/**
 * Presentation mode is not an authorization boundary.
 * The authenticated /api/desk-mode response is derived from the server's host allowlist.
 * Marketing and Inbox are destinations within the server "comms" mode.
 */
export type ServerDeskMode = "workforce" | "comms";
export type ProductMode = "marketing" | "inbox";

export function parseServerDeskMode(value: unknown): ServerDeskMode | null {
  return value === "workforce" || value === "comms" ? value : null;
}

export function productModeForPath(pathname: string): ProductMode | null {
  if (pathname === "/app/modes/marketing" || pathname.startsWith("/app/modes/marketing/")) return "marketing";
  if (pathname === "/app/modes/inbox" || pathname.startsWith("/app/modes/inbox/")) return "inbox";
  if (pathname === "/app/chatbot-inbox" || pathname.startsWith("/app/chatbot-admin/")) return "inbox";
  if (pathname.startsWith("/app/campaigns") || pathname.startsWith("/app/flows")) return "marketing";
  return null;
}

export function isCommsHostMode(mode: ServerDeskMode | null): boolean {
  return mode === "comms";
}
