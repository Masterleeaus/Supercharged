/**
 * SQL helpers for the pgvector store (Phase 1, W5, issue #379).
 *
 * Identifiers are checked against a strict pattern and then quoted. Values are always bound as parameters.
 * A vector is sent as a text literal and cast to vector in SQL.
 *
 * The issue asks to copy Mastra's sql-builder and filter translator. The Mastra source is not in this
 * repository and was not fetched, so these helpers are written from scratch. No Mastra code is copied.
 *
 * Licence: original TitanZero code. See source/mastra-apache-only/README.md.
 */
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const FILTER_KEY = /^[A-Za-z0-9_]{1,64}$/;

export function quoteIdent(name: string): string {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error('pg_identifier_invalid');
  return `"${name}"`;
}

export function vectorLiteral(values: readonly number[], dimensions: number): string {
  if (!Array.isArray(values) || values.length !== dimensions) throw new Error('pg_vector_dimension_mismatch');
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('pg_vector_value_invalid');
  }
  return `[${values.join(',')}]`;
}

export type FilterValue = string | number | boolean;

/**
 * Turns { key: value } into parameterised clauses against the jsonb metadata column.
 * Keys are restricted to letters, digits and underscore. Values must be primitives.
 */
export function metadataFilterClause(
  filter: Readonly<Record<string, FilterValue>> | undefined,
  column: string,
  firstParam: number,
): { sql: string; params: FilterValue[]; nextParam: number } {
  const params: FilterValue[] = [];
  const parts: string[] = [];
  let n = firstParam;
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (!FILTER_KEY.test(key)) throw new Error('pg_filter_key_invalid');
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('pg_filter_value_invalid');
    parts.push(`${quoteIdent(column)}->>'${key}' = $${n}`);
    params.push(String(value));
    n += 1;
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params, nextParam: n };
}
