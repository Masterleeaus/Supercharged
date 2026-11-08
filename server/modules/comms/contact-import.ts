// Contact CSV import and export for one company. Pure functions: no store, no network, no HTTP.
// Email and phone normalisation is delegated to contact-dedupe.ts.

import { normalizeEmail, normalizePhone } from './contact-dedupe.ts';

export interface ImportOptions {
  companyId: string;
  /** Maximum number of data rows processed. Rows past this count are rejected with 'row_limit'. */
  maxRows?: number;
  /** Country calling code used to read national phone numbers with a leading 0, e.g. "61". */
  defaultCountryCode?: string;
}

export type RejectReason =
  | 'missing_contact'
  | 'invalid_email'
  | 'invalid_phone'
  | 'duplicate_in_file'
  | 'row_limit'
  | 'invalid_company';

export interface ImportedContact {
  /** Physical line number of the record in the source text. The header is line 1. */
  line: number;
  companyId: string;
  name: string;
  email?: string;
  phone?: string;
}

export interface RejectedRow {
  /** Line number of the rejected record. 0 means the whole import was refused. */
  line: number;
  reason: RejectReason;
}

export interface ImportResult {
  accepted: ImportedContact[];
  rejected: RejectedRow[];
}

export interface ExportableContact {
  companyId: string;
  id?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** What the caller's guard is asked about. The guard decides roles; this module does not. */
export interface ExportGuardRequest {
  action: 'audience_export';
  companyId: string;
  actorId: string;
}

/** Injected role gate. Must return exactly true to allow the export. */
export type ExportGuard = (request: ExportGuardRequest) => boolean;

/** Append-only audit record for one export. Written through the caller's audit sink. */
export interface ExportAuditEntry {
  action: 'comms.audience_export';
  companyId: string;
  actorId: string;
  rowCount: number;
  /** ISO 8601 time from the caller's `now`. */
  at: string;
}

export interface ExportOptions {
  companyId: string;
  actorId: string;
  /** ISO 8601 timestamp recorded on the audit entry. */
  now: string;
  /** Required. Without it the export is refused. */
  guard: ExportGuard;
  /** Required. Called before the CSV is returned. If it throws, no CSV is returned. */
  audit: (entry: ExportAuditEntry) => void;
}

export type ExportRefusalReason =
  | 'invalid_company'
  | 'invalid_actor'
  | 'guard_missing'
  | 'not_permitted'
  | 'audit_missing';

export class ContactExportRefused extends Error {
  readonly reason: ExportRefusalReason;
  constructor(reason: ExportRefusalReason) {
    super('export_refused');
    this.name = 'ContactExportRefused';
    this.reason = reason;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_ROWS = 5000;
const EXPORT_HEADER = 'name,email,phone';

interface CsvRecord {
  line: number;
  cells: string[];
}

/**
 * Splits CSV text into records. Supports quoted fields, doubled quotes inside quoted fields,
 * quoted line breaks, and LF, CRLF or CR line endings. Blank lines are dropped.
 * Each record keeps the physical line on which it starts.
 */
function parseCsv(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endRecord = (): void => {
    cells.push(field);
    field = '';
    records.push({ line: recordLine, cells });
    cells = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      cells.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRecord();
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      line += 1;
      recordLine = line;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (cells.length > 0 || field !== '') endRecord();

  return records.filter((r) => !(r.cells.length === 1 && r.cells[0] === ''));
}

/**
 * Parses a contact CSV for one company. The first row is the header and must contain a "name"
 * column plus an "email" or "phone" column (or both). Each data row needs at least one valid contact
 * value. Rows are checked in file order: the first occurrence of an email or phone is accepted and
 * later rows that repeat it are rejected as 'duplicate_in_file'.
 *
 * Throws when the header lacks a required column. Returns { rejected: [{ line: 0, reason: 'invalid_company' }] }
 * when companyId is not a UUID.
 */
export function parseContactCsv(text: string, options: ImportOptions): ImportResult {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const accepted: ImportedContact[] = [];
  const rejected: RejectedRow[] = [];

  if (typeof options.companyId !== 'string' || !UUID.test(options.companyId)) {
    return { accepted, rejected: [{ line: 0, reason: 'invalid_company' }] };
  }

  const records = parseCsv(text);
  if (records.length === 0) {
    throw new Error('contact CSV has no header row');
  }

  const header = records[0].cells.map((c) => c.trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  const emailIdx = header.indexOf('email');
  const phoneIdx = header.indexOf('phone');
  if (nameIdx < 0 || (emailIdx < 0 && phoneIdx < 0)) {
    throw new Error('contact CSV header needs a name column and an email or phone column');
  }

  const phoneOpts = { defaultCountryCode: options.defaultCountryCode };
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const dataRows = records.slice(1);

  dataRows.forEach((row, index) => {
    if (index >= maxRows) {
      rejected.push({ line: row.line, reason: 'row_limit' });
      return;
    }

    const rawName = (row.cells[nameIdx] ?? '').trim();
    const rawEmail = emailIdx >= 0 ? (row.cells[emailIdx] ?? '').trim() : '';
    const rawPhone = phoneIdx >= 0 ? (row.cells[phoneIdx] ?? '').trim() : '';

    if (rawEmail === '' && rawPhone === '') {
      rejected.push({ line: row.line, reason: 'missing_contact' });
      return;
    }

    let email: string | undefined;
    if (rawEmail !== '') {
      email = normalizeEmail(rawEmail);
      if (email === undefined) {
        rejected.push({ line: row.line, reason: 'invalid_email' });
        return;
      }
    }

    let phone: string | undefined;
    if (rawPhone !== '') {
      phone = normalizePhone(rawPhone, phoneOpts);
      if (phone === undefined) {
        rejected.push({ line: row.line, reason: 'invalid_phone' });
        return;
      }
    }

    if ((email !== undefined && seenEmails.has(email)) || (phone !== undefined && seenPhones.has(phone))) {
      rejected.push({ line: row.line, reason: 'duplicate_in_file' });
      return;
    }

    if (email !== undefined) seenEmails.add(email);
    if (phone !== undefined) seenPhones.add(phone);

    const contact: ImportedContact = { line: row.line, companyId: options.companyId, name: rawName };
    if (email !== undefined) contact.email = email;
    if (phone !== undefined) contact.phone = phone;
    accepted.push(contact);
  });

  return { accepted, rejected };
}

/**
 * Escapes one CSV cell. Values starting with =, +, -, @, tab or carriage return get a leading single
 * quote so spreadsheets do not evaluate them as formulas. Values containing a comma, quote or line break are quoted.
 */
function csvCell(value: string | null | undefined): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Exports one company's contacts as CSV with the fixed header name,email,phone.
 * Only contacts whose companyId equals options.companyId are included, in input order.
 *
 * Refuses (throws ContactExportRefused) when the company is not a UUID, the actor is missing,
 * the guard is missing or does not return true, or the audit sink is missing. The audit entry is
 * written before the CSV is returned, so an export is never handed out unrecorded.
 */
export function exportContactCsv(contacts: ReadonlyArray<ExportableContact>, options: ExportOptions): string {
  if (typeof options?.companyId !== 'string' || !UUID.test(options.companyId)) {
    throw new ContactExportRefused('invalid_company');
  }
  if (typeof options.actorId !== 'string' || options.actorId.trim().length === 0) {
    throw new ContactExportRefused('invalid_actor');
  }
  if (typeof options.guard !== 'function') {
    throw new ContactExportRefused('guard_missing');
  }
  const allowed = options.guard({
    action: 'audience_export',
    companyId: options.companyId,
    actorId: options.actorId,
  });
  if (allowed !== true) {
    throw new ContactExportRefused('not_permitted');
  }
  if (typeof options.audit !== 'function') {
    throw new ContactExportRefused('audit_missing');
  }

  const lines: string[] = [EXPORT_HEADER];
  for (const contact of contacts) {
    if (contact.companyId !== options.companyId) continue;
    lines.push([contact.name, contact.email, contact.phone].map(csvCell).join(','));
  }

  options.audit({
    action: 'comms.audience_export',
    companyId: options.companyId,
    actorId: options.actorId,
    rowCount: lines.length - 1,
    at: options.now,
  });
  return `${lines.join('\n')}\n`;
}
