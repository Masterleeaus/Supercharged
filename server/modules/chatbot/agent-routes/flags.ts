/**
 * Feature flag for the staff reply and handoff routes. Default OFF.
 *
 * Read from the process environment, and only the exact string "true" enables it, the same rule
 * server/index.ts uses for DEMO_MODE. With the flag off, createAgentRouter mounts a router that answers 404 on
 * every path, so the routes are absent rather than unauthenticated.
 */
export const AGENT_ROUTES_FLAG = "DESK_CHATBOT_AGENT_ROUTES";

export function isAgentRoutesEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[AGENT_ROUTES_FLAG] === "true";
}
