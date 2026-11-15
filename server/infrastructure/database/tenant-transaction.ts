/**
 * Drizzle transaction variant of withTenant().
 *
 * Chatbot stores receive a drizzle handle (server/db.ts), not a pinned pg client, so
 * they cannot call withTenant() directly. withTenantTransaction() gives them the same
 * guarantee for one unit of work: the company id is written with
 * set_config(..., is_local = true) as the first statement of the transaction, and
 * every query in fn must run through the transaction handle it receives.
 *
 * It does not switch role (withTenant does that on the pinned client), and it does not
 * add any policy. Tables are still not scoped by database policy; that is the follow-up
 * migration that reads COMPANY_SETTING.
 */
import { sql } from "drizzle-orm";
import { assertCompanyId, COMPANY_SETTING } from "./tenant-context.ts";

/** The part of a drizzle database handle this helper needs. */
export interface TenantTransactional {
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/**
 * Runs fn(tx) inside one transaction scoped to companyId.
 *
 * Order: BEGIN (drizzle), set_config(app.company_id, <uuid>, true), fn(tx), COMMIT.
 * The companyId is validated before the transaction opens, so an invalid value never
 * reaches the database. An error inside fn rolls the whole transaction back.
 */
export async function withTenantTransaction<T>(
  db: TenantTransactional,
  companyId: string,
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  const tenant = assertCompanyId(companyId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${COMPANY_SETTING}, ${tenant}, true)`);
    return fn(tx);
  });
}
