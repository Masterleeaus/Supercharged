// Company-level settings. Quiet hours are one setting per company: a start and end hour, plus the
// timezone it was saved under. The window is read in each recipient's own IANA timezone
// (contact.timezone), never the company's.
//
// Two adapters share one contract:
//   - Postgres (production): table company_quiet_hours, every query run through withTenant so the
//     session carries the company. Build it with { pool }.
//   - In-memory Map (tests only): build it with { memoryForTests: true }. Refused when
//     NODE_ENV is 'production'.
//
// Every operation takes companyId first and refuses anything that is not a UUID. Results are plain
// objects: { ok: true, ... } or { ok: false, reason }. The company id must come from the verified
// request (requireCompanyScope), never from a request body.

import { assertCompanyId, withTenant, type TenantPool, type TenantQueryClient } from '../../infrastructure/database/tenant-context.ts';

// Same pattern as server/infrastructure/database/tenant-context.ts (copied, not imported).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompanySettingsReason = 'invalid_company' | 'invalid_hour' | 'invalid_timezone';

export interface QuietHoursInput {
  startHour: number;
  endHour: number;
  timezone: string;
}

export interface QuietHoursSetting {
  companyId: string;
  startHour: number;
  endHour: number;
  /**
   * A valid IANA timezone, validated on write. The window is NOT read in this zone: quiet hours
   * are evaluated in each recipient's timezone (contact.timezone). Kept so existing callers and
   * stored values keep their shape.
   */
  timezone: string;
  updatedAt: string;
}

export type CompanySettingsResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; reason: CompanySettingsReason };

export interface CompanySettingsStore {
  setQuietHours(
    companyId: string,
    input: QuietHoursInput,
  ): Promise<CompanySettingsResult<{ settings: QuietHoursSetting }>>;
  getQuietHours(companyId: string): Promise<CompanySettingsResult<{ settings: QuietHoursSetting | null }>>;
  clearQuietHours(companyId: string): Promise<CompanySettingsResult<{ cleared: boolean }>>;
}

export interface CreateCompanySettingsStoreOptions {
  /** Injected clock. Each set records updatedAt from this. Defaults to the system clock. */
  now?: () => Date;
  /** Postgres adapter: the app pool. Queries run through withTenant. */
  pool?: TenantPool;
  /** Explicit in-memory test adapter. Never for production code. */
  memoryForTests?: boolean;
}

export interface CompanySettingsRow {
  company_id: string;
  start_hour: number;
  end_hour: number;
  timezone: string;
  updated_at: Date | string;
}

function isValidCompanyId(companyId: unknown): companyId is string {
  return typeof companyId === 'string' && UUID_RE.test(companyId);
}

function isValidHour(hour: unknown): hour is number {
  return typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23;
}

// Intl.DateTimeFormat throws a RangeError for any zone name it does not recognise.
function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The reason a quiet-hours input is refused, or null when it is valid. */
function quietHoursProblem(input: QuietHoursInput | null | undefined): CompanySettingsReason | null {
  if (!input || !isValidHour(input.startHour) || !isValidHour(input.endHour)) return 'invalid_hour';
  if (!isValidTimezone(input.timezone)) return 'invalid_timezone';
  return null;
}

function rowToSetting(row: CompanySettingsRow): QuietHoursSetting {
  return {
    companyId: row.company_id,
    startHour: row.start_hour,
    endHour: row.end_hour,
    timezone: row.timezone,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

let defaultStore: CompanySettingsStore | null = null;

/**
 * The process-wide fallback store, used only when a caller injects no store (createCampaignService
 * without deps.companySettings). Production wiring injects the Postgres store (see routes.ts), so
 * this fallback is in-memory. It does not persist.
 */
export function getDefaultCompanySettingsStore(): CompanySettingsStore {
  if (!defaultStore) defaultStore = buildMemoryStore({ memoryForTests: true });
  return defaultStore;
}

/**
 * Test-only override of the shared store. Pass null to drop it so the next read builds a fresh
 * default. Production code must not call this.
 */
export function setDefaultCompanySettingsStore(store: CompanySettingsStore | null): void {
  defaultStore = store;
}

/**
 * With no argument, returns the process default (see getDefaultCompanySettingsStore).
 * With { pool }, returns the Postgres adapter. With { memoryForTests: true }, returns the in-memory
 * test adapter. Any other options are refused, so a production caller cannot fall back to memory by accident.
 */
export function createCompanySettingsStore(options?: CreateCompanySettingsStoreOptions): CompanySettingsStore {
  if (options === undefined) return getDefaultCompanySettingsStore();
  if (options.memoryForTests === true) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('company-settings: the in-memory adapter is test-only and cannot run in production');
    }
    return buildMemoryStore(options);
  }
  if (options.pool) return buildPostgresStore({ ...options, pool: options.pool });
  throw new TypeError('createCompanySettingsStore needs { pool } for Postgres, or { memoryForTests: true } in tests');
}

/** Postgres adapter. Every query runs in withTenant, and also filters on company_id explicitly. */
function buildPostgresStore(options: CreateCompanySettingsStoreOptions & { pool: TenantPool }): CompanySettingsStore {
  const now = options.now ?? (() => new Date());
  const pool = options.pool;

  // withTenant validates the UUID before it takes a connection, so an invalid id never reaches Postgres.
  const inTenant = <T>(companyId: string, fn: (client: TenantQueryClient) => Promise<T>): Promise<T> =>
    withTenant(pool, assertCompanyId(companyId), fn);

  return {
    async setQuietHours(companyId, input) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      const problem = quietHoursProblem(input);
      if (problem) return { ok: false, reason: problem };

      const key = companyId.toLowerCase();
      const updatedAt = now();
      const result = await inTenant(key, (client) =>
        client.query(
          `INSERT INTO company_quiet_hours (company_id, start_hour, end_hour, timezone, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (company_id) DO UPDATE
             SET start_hour = EXCLUDED.start_hour,
                 end_hour = EXCLUDED.end_hour,
                 timezone = EXCLUDED.timezone,
                 updated_at = EXCLUDED.updated_at
           RETURNING company_id, start_hour, end_hour, timezone, updated_at`,
          [key, input.startHour, input.endHour, input.timezone, updatedAt.toISOString()],
        ),
      );
      return { ok: true, settings: rowToSetting(result.rows[0] as CompanySettingsRow) };
    },

    async getQuietHours(companyId) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      const key = companyId.toLowerCase();
      const result = await inTenant(key, (client) =>
        client.query(
          `SELECT company_id, start_hour, end_hour, timezone, updated_at
             FROM company_quiet_hours
            WHERE company_id = $1`,
          [key],
        ),
      );
      const row = result.rows[0] as CompanySettingsRow | undefined;
      return { ok: true, settings: row ? rowToSetting(row) : null };
    },

    async clearQuietHours(companyId) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      const key = companyId.toLowerCase();
      const result = await inTenant(key, (client) =>
        client.query(`DELETE FROM company_quiet_hours WHERE company_id = $1 RETURNING company_id`, [key]),
      );
      return { ok: true, cleared: result.rows.length > 0 };
    },
  };
}

/** In-memory adapter. Test use only. Stored values are copied on the way in and out. */
function buildMemoryStore(options: CreateCompanySettingsStoreOptions): CompanySettingsStore {
  const now = options.now ?? (() => new Date());
  // Keyed by lowercase UUID so the same company written in either case maps to one record.
  const quietHours = new Map<string, QuietHoursSetting>();

  const copy = (setting: QuietHoursSetting): QuietHoursSetting => ({ ...setting });

  return {
    async setQuietHours(companyId, input) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      const problem = quietHoursProblem(input);
      if (problem) return { ok: false, reason: problem };

      const key = companyId.toLowerCase();
      const setting: QuietHoursSetting = {
        companyId: key,
        startHour: input.startHour,
        endHour: input.endHour,
        timezone: input.timezone,
        updatedAt: now().toISOString(),
      };
      quietHours.set(key, setting);
      return { ok: true, settings: copy(setting) };
    },

    async getQuietHours(companyId) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      const setting = quietHours.get(companyId.toLowerCase());
      return { ok: true, settings: setting ? copy(setting) : null };
    },

    async clearQuietHours(companyId) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      return { ok: true, cleared: quietHours.delete(companyId.toLowerCase()) };
    },
  };
}
