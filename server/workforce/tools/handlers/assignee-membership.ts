/**
 * Checks that an assignee user belongs to the caller's company, using the company_memberships table
 * (migrations/0016_company_memberships.sql). The query is scoped by company_id, so a membership in another company
 * does not count. An absent assignee (undefined or null) needs no check.
 *
 * The caller runs this before any write that sets an assignee, inside the same executor, so a refusal writes nothing.
 */
import type { SqlExecutor } from '../../runtime/pg-store.ts';

export class AssigneeNotMemberError extends Error {
  constructor() {
    super('assignee is not a member of this company; nothing was written');
    this.name = 'AssigneeNotMemberError';
  }
}

export async function assertAssigneeInCompany(db: SqlExecutor, companyId: string, userId: unknown): Promise<void> {
  if (userId === undefined || userId === null) return;
  const result = await db.query(
    'SELECT 1 FROM company_memberships WHERE company_id = $1 AND user_id = $2 LIMIT 1',
    [companyId, userId],
  );
  if (result.rows.length === 0) throw new AssigneeNotMemberError();
}
