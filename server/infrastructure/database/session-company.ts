/**
 * Session-to-company resolution for Desk.
 *
 * A session is bound to exactly one company. A user can hold memberships in
 * several companies (user_company_memberships, migration 0017), so the rows
 * that come back for a session are checked here before any company id is used:
 *
 *   - zero valid company ids  -> null (no company, requireCompanyScope() refuses)
 *   - exactly one valid id    -> that id, lower-cased
 *   - two or more distinct ids -> null (ambiguous; the session must pick one first)
 *
 * Values that are not UUIDs are ignored, so a malformed row cannot widen the
 * set of companies. Fails closed on every path that does not yield one id.
 */
import { isCompanyId } from "./tenant-context.ts";

/**
 * Returns the single company id that the membership rows allow, or null.
 * Accepts any iterable of raw values (for example pg rows mapped to company_id).
 */
export function resolveSessionCompany(
  companyIds: Iterable<unknown>,
): string | null {
  const distinct = new Set<string>();
  for (const value of companyIds) {
    if (!isCompanyId(value)) continue;
    distinct.add(value.toLowerCase());
    if (distinct.size > 1) return null;
  }
  if (distinct.size !== 1) return null;
  return [...distinct][0];
}
