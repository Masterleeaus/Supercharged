/**
 * Company scope for Desk routes.
 *
 * The company id is read from the authenticated user only:
 *   req.user.companyId
 * It is never read from req.body, req.query, req.params or request headers.
 * A client cannot choose its tenant by sending a different value.
 *
 * server/middleware/auth.ts and hybrid-auth.ts copy companyId from the signed
 * JWT onto req.user. The claim is taken from users.company_id when the token is
 * issued. If the user has no company, the claim is absent and req.user.companyId
 * stays undefined, so routes behind requireCompanyScope() return 403. That is
 * intended (fail closed).
 */
import type { Request, Response, NextFunction } from "express";
import { isCompanyId } from "../infrastructure/database/tenant-context.ts";

export class CompanyScopeError extends Error {
  constructor(message = "Company scope required") {
    super(message);
    this.name = "CompanyScopeError";
  }
}

interface AuthenticatedUserLike {
  companyId?: unknown;
}

/** Reads and validates the company id from the authenticated user. Returns null if absent or invalid. */
function readCompanyIdFromUser(req: Request): string | null {
  const user = (req as Request & { user?: AuthenticatedUserLike }).user;
  const value = user?.companyId;
  return isCompanyId(value) ? value : null;
}

/**
 * Returns the authenticated company id for use in a route handler.
 * Throws CompanyScopeError if the request has no valid company scope.
 */
export function getCompanyScope(req: Request): string {
  const companyId = readCompanyIdFromUser(req);
  if (!companyId) throw new CompanyScopeError();
  return companyId;
}

/**
 * Express middleware. Responds 403 when the authenticated user has no valid
 * company_id, and otherwise calls next(). Must run after authenticateToken
 * (or another auth middleware that sets req.user).
 */
export function requireCompanyScope() {
  return (req: Request, res: Response, next: NextFunction) => {
    const companyId = readCompanyIdFromUser(req);
    if (!companyId) {
      return res.status(403).json({ error: "Company scope required" });
    }
    // Downstream routers (chatbot, approvals) read the verified company from res.locals only.
    res.locals = res.locals ?? {};
    res.locals.companyId = companyId;
    next();
  };
}
