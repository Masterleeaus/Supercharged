/**
 * Canonical job statuses for field-service connectors (#355).
 *
 * Every vendor status maps onto this set through a per-vendor table. A vendor status that is not in
 * the table maps to "unknown" (field-mapping.ts UNKNOWN_STATUS), so a new vendor status never fails a read.
 */
export const CANONICAL_JOB_STATUSES = [
  'new',
  'scheduled',
  'in_progress',
  'on_hold',
  'completed',
  'invoiced',
  'cancelled',
] as const;

export type CanonicalJobStatus = (typeof CANONICAL_JOB_STATUSES)[number];

/** Checks a vendor-to-canonical table. Returns problems; empty means every target is canonical. */
export function checkStatusTable(table: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [vendorStatus, canonical] of Object.entries(table)) {
    if (!(CANONICAL_JOB_STATUSES as readonly string[]).includes(canonical)) {
      problems.push(`"${vendorStatus}" maps to non-canonical "${canonical}"`);
    }
  }
  return problems;
}
