// Company-level settings, in memory. Quiet hours are one setting per company: a start and end hour.
// The window is read in each recipient's own IANA timezone (contact.timezone), never the company's.
// No database, no network. Every operation takes companyId first and
// refuses anything that is not a UUID. Results are plain objects: { ok: true, ... } or
// { ok: false, reason }. Stored values are copied on the way in and out, so callers cannot mutate
// the store by holding a reference.

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
  ): CompanySettingsResult<{ settings: QuietHoursSetting }>;
  getQuietHours(companyId: string): CompanySettingsResult<{ settings: QuietHoursSetting | null }>;
  clearQuietHours(companyId: string): CompanySettingsResult<{ cleared: boolean }>;
}

export interface CreateCompanySettingsStoreOptions {
  /** Injected clock. Each set records updatedAt from this. Defaults to the system clock. */
  now?: () => Date;
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

let defaultStore: CompanySettingsStore | null = null;

/**
 * The one company-settings store shared by the whole process. Quiet hours set through it are seen
 * by every caller that reads it, including the campaign service's default wiring.
 */
export function getDefaultCompanySettingsStore(): CompanySettingsStore {
  if (!defaultStore) defaultStore = buildCompanySettingsStore({});
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
 * With no argument, returns the shared process default (see getDefaultCompanySettingsStore).
 * With any options, returns a private store that does not share state with the default.
 */
export function createCompanySettingsStore(options?: CreateCompanySettingsStoreOptions): CompanySettingsStore {
  if (options === undefined) return getDefaultCompanySettingsStore();
  return buildCompanySettingsStore(options);
}

function buildCompanySettingsStore(options: CreateCompanySettingsStoreOptions): CompanySettingsStore {
  const now = options.now ?? (() => new Date());
  // Keyed by lowercase UUID so the same company written in either case maps to one record.
  const quietHours = new Map<string, QuietHoursSetting>();

  const copy = (setting: QuietHoursSetting): QuietHoursSetting => ({ ...setting });

  return {
    setQuietHours(companyId, input) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      if (!input || !isValidHour(input.startHour) || !isValidHour(input.endHour)) {
        return { ok: false, reason: 'invalid_hour' };
      }
      if (!isValidTimezone(input.timezone)) return { ok: false, reason: 'invalid_timezone' };

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

    getQuietHours(companyId) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      const setting = quietHours.get(companyId.toLowerCase());
      return { ok: true, settings: setting ? copy(setting) : null };
    },

    clearQuietHours(companyId) {
      if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
      return { ok: true, cleared: quietHours.delete(companyId.toLowerCase()) };
    },
  };
}
