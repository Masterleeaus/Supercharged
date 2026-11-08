/**
 * Desk company_id -> Field account_id mapping.
 *
 * Rules:
 * - The mapping is looked up from this table. It is never inferred from a user id,
 *   a request body, a header, a session or an email domain.
 * - The only input is the Desk company_id read from a server-side record.
 * - Anything not explicitly mapped returns null, and the client then refuses to call Field.
 */

export interface FieldCompanyMap {
  /** Returns the Field account_id for a Desk company_id, or null when unmapped. */
  lookup(deskCompanyId: string): Promise<string | null>;
}

/** Fail-closed default. Every lookup is unmapped, so no request is sent to Field. */
export const DENY_ALL_COMPANY_MAP: FieldCompanyMap = Object.freeze({
  async lookup(): Promise<string | null> {
    return null;
  },
});

/**
 * Builds a map from an explicit list of pairs, for example loaded from reviewed configuration.
 * Keys are compared exactly. Prototype names such as "constructor" are not special.
 */
export function createStaticCompanyMap(pairs: ReadonlyArray<readonly [deskCompanyId: string, fieldAccountId: string]>): FieldCompanyMap {
  const table = new Map<string, string>();
  for (const [deskCompanyId, fieldAccountId] of pairs) {
    const desk = String(deskCompanyId ?? '').trim();
    const account = String(fieldAccountId ?? '').trim();
    if (!desk || !account) throw new Error('field-link-company-map-entry-invalid');
    if (table.has(desk) && table.get(desk) !== account) throw new Error('field-link-company-map-duplicate-key');
    table.set(desk, account);
  }
  return Object.freeze({
    async lookup(deskCompanyId: string): Promise<string | null> {
      const key = String(deskCompanyId ?? '').trim();
      if (!key) return null;
      return table.get(key) ?? null;
    },
  });
}
