/**
 * Resolves the company for a team member from the parent user's row.
 *
 * Link: team_members.team_id -> teams.id, teams.user_id -> users.id.
 * The parent user id arrives from the validated team session, never from the request.
 *
 * Returns undefined when the parent has no company, the value is not a UUID,
 * or the lookup fails. Callers leave companyId unset, so requireCompanyScope fails closed.
 */

import { db } from "../db";
import { eq } from "drizzle-orm";
import { users } from "../../shared/schema";
import { isCompanyId } from "../infrastructure/database/tenant-context";
import { logger } from '../utils/logger.ts';

export async function lookupParentCompanyId(parentUserId: string): Promise<string | undefined> {
  try {
    const [row] = await db
      .select({ companyId: users.companyId })
      .from(users)
      .where(eq(users.id, parentUserId))
      .limit(1);
    const companyId: unknown = row?.companyId;
    return isCompanyId(companyId) ? companyId : undefined;
  } catch (error) {
    logger.error("[HybridAuth] Parent company lookup failed; companyId left unset:", error);
    return undefined;
  }
}
