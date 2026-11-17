/**
 * Field-mapping layer (#349). Each company maps its own vendor fields and statuses onto the
 * canonical entity fields. Pure: no I/O.
 *
 * Unknown vendor statuses map to the canonical value "unknown" rather than failing the read, so one
 * unexpected status does not hide a whole batch. Missing source fields become null.
 */
import { ConnectorError } from './contract.ts';

export interface EntityMapping {
  /** canonical field name -> dotted source path, e.g. { fullName: "contact.display_name" } */
  fields: Record<string, string>;
  /** vendor status -> canonical status */
  statuses?: Record<string, string>;
  /** the source path holding the vendor status, when statuses is used */
  statusPath?: string;
}

export const UNKNOWN_STATUS = 'unknown';

const MAX_PATH_DEPTH = 8;

/** Reads a dotted path. Refuses prototype keys so a mapping cannot reach into Object internals. */
export function readPath(source: unknown, path: string): unknown {
  const segments = path.split('.');
  if (segments.length > MAX_PATH_DEPTH) throw new ConnectorError('validation', 'mapping path too deep');
  let current: unknown = source;
  for (const segment of segments) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      throw new ConnectorError('validation', 'mapping path uses a reserved key');
    }
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

export function mapRecord(source: unknown, mapping: EntityMapping): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [canonical, sourcePath] of Object.entries(mapping.fields)) {
    out[canonical] = readPath(source, sourcePath);
  }
  if (mapping.statuses !== undefined && mapping.statusPath !== undefined) {
    const vendorStatus = readPath(source, mapping.statusPath);
    const mapped = typeof vendorStatus === 'string' ? mapping.statuses[vendorStatus] : undefined;
    out.status = mapped ?? UNKNOWN_STATUS;
  }
  return out;
}

/** Validates a mapping before it is stored: every path is well formed and no canonical field is empty. */
export function checkMapping(mapping: EntityMapping): string[] {
  const problems: string[] = [];
  if (Object.keys(mapping.fields).length === 0) problems.push('mapping needs at least one field');
  for (const [canonical, path] of Object.entries(mapping.fields)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(canonical)) problems.push(`canonical field "${canonical}" is not a valid name`);
    if (typeof path !== 'string' || path.length === 0) problems.push(`field "${canonical}" needs a source path`);
    else if (path.split('.').length > MAX_PATH_DEPTH) problems.push(`field "${canonical}" path is too deep`);
  }
  if (mapping.statuses !== undefined && mapping.statusPath === undefined) problems.push('statuses needs statusPath');
  return problems;
}
