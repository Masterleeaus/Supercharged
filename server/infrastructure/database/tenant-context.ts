/**
 * Tenant (company) scoping primitives for Desk.
 *
 * withTenant() is the only code path that sets the tenant for a database
 * session. It pins one pooled connection for one transaction, drops to the
 * restricted application role, and writes the company id with
 * set_config(..., is_local = true). Everything is transaction-local, so a
 * pooled connection cannot carry one company's id into the next request.
 *
 * Nothing in this file touches an existing table or query. Tables are not
 * scoped until the migration plan in docs/TENANCY.md is carried out.
 *
 * Design notes adapted from MIT-licensed references (multi-tenant-rls and
 * pgrls): set_config with a bind parameter instead of SET LOCAL interpolation,
 * transaction-local settings, and nullif() on the policy side.
 */

/** Minimal shape of a pg client that withTenant needs. */
export interface TenantQueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(err?: unknown): void;
}

/** Minimal shape of a pg Pool that withTenant needs. */
export interface TenantPool {
  connect(): Promise<TenantQueryClient>;
}

export interface WithTenantOptions {
  /**
   * Restricted role to SET LOCAL ROLE to for the duration of the transaction.
   * Defaults to DESK_APP_DB_ROLE from the environment, then to "desk_app".
   */
  appRole?: string;
}

export const DEFAULT_APP_ROLE = "desk_app";
/** The session setting that the policies in migrations/DRAFT_company_scope.sql read. */
export const COMPANY_SETTING = "app.company_id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

/** True only for a non-empty string that is exactly a UUID. */
export function isCompanyId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Throws TenantContextError unless value is a UUID. Fails closed. */
export function assertCompanyId(value: unknown): string {
  if (!isCompanyId(value)) {
    throw new TenantContextError(
      "withTenant: companyId must be a UUID; refusing to run without a tenant",
    );
  }
  return value;
}

function resolveAppRole(options: WithTenantOptions): string {
  const role =
    options.appRole ?? process.env.DESK_APP_DB_ROLE ?? DEFAULT_APP_ROLE;
  if (typeof role !== "string" || !ROLE_RE.test(role)) {
    throw new TenantContextError(
      "withTenant: appRole must be a plain lower-case SQL identifier",
    );
  }
  return role;
}

/**
 * Runs fn(client) inside one transaction scoped to a single company.
 *
 * Order of operations on the pinned client:
 *   BEGIN
 *   SET LOCAL ROLE "<appRole>"            (restricted role: not owner, no BYPASSRLS)
 *   SELECT set_config('app.company_id', $1, true)   (bind parameter, never interpolated)
 *   fn(client)
 *   COMMIT                                 (ROLLBACK and rethrow on any error)
 *
 * The companyId and appRole are validated before a connection is taken from
 * the pool, so an invalid value never reaches the database.
 *
 * fn must run every query through the client it receives. Queries made through
 * the pool directly are outside the tenant.
 */
export async function withTenant<T>(
  pool: TenantPool,
  companyId: string,
  fn: (client: TenantQueryClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  // Validate everything before touching the pool.
  const tenant = assertCompanyId(companyId);
  const role = resolveAppRole(options);

  const client = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query("SELECT set_config($1, $2, true)", [
      COMPANY_SETTING,
      tenant,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    let rollbackError: unknown;
    let rollbackFailed = false;
    try {
      await client.query("ROLLBACK");
    } catch (err) {
      // The original error is the one the caller needs. If ROLLBACK itself
      // failed, destroy the connection so a half-open transaction is never
      // handed to another request.
      rollbackFailed = true;
      rollbackError = err;
    }
    released = true;
    if (rollbackFailed) client.release(rollbackError);
    else client.release();
    throw error;
  } finally {
    if (!released) client.release();
  }
}
