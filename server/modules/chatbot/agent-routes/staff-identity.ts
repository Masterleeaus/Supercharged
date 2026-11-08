/**
 * Staff identity resolver for the agent surface (/api/chatbot/agent).
 *
 * The caller is read only from req.user. The main app's authenticate middleware (authenticateHybrid in
 * server/middleware/hybrid-auth.ts) sets req.user from a verified JWT, and it runs in front of the agent mount.
 * Headers, params, query and body are never read here, so a client cannot choose its company or its role.
 *
 * Fail closed:
 * - No verified user, or no user id: null. The router answers 401.
 * - No company on the user, or a company id that is not a UUID: passed on as "" so requireCompanyId in the
 *   handlers answers 403.
 * - A role the route does not allow (for example "user", or a team member): passed on unchanged. The handlers
 *   answer 403 because the route's role list does not include it.
 */
import type { AgentHttpRequest, StaffIdentity } from "./agent-handlers.ts";

export function resolveAgentStaffIdentity(req: AgentHttpRequest): StaffIdentity | null {
  const user: unknown = req.user;
  if (!user || typeof user !== "object") return null;

  const { id, role, companyId } = user as { id?: unknown; role?: unknown; companyId?: unknown };
  if (typeof id !== "string" || id.length === 0) return null;

  return {
    staffId: id,
    role: typeof role === "string" ? role : "",
    companyId: typeof companyId === "string" ? companyId : "",
  };
}
