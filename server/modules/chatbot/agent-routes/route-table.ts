/** Mounted paths for the staff reply and handoff routes, relative to the mount point. Kept free of Express. */
export const AGENT_ROUTE_PATHS = [
  { method: "GET", path: "/inbox" },
  { method: "GET", path: "/conversations/:id" },
  { method: "POST", path: "/conversations/:id/messages" },
  { method: "POST", path: "/conversations/:id/takeover" },
  { method: "POST", path: "/conversations/:id/handback" },
  { method: "POST", path: "/conversations/:id/close" },
] as const;
