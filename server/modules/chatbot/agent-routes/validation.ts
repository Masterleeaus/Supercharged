/**
 * Input validation for the staff routes. Hand-written rather than zod, so this slice runs without
 * node_modules. Every schema is strict: an unknown key is an error, which means a body or query that
 * carries companyId, staffId or any other tenancy field is rejected instead of ignored.
 */

export const MAX_REPLY_LENGTH = 10000;
export const MAX_SEARCH_LENGTH = 200;
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export interface StaffReplyInput {
  message: string;
  isInternalNote: boolean;
}

export interface InboxQueryInput {
  handler?: "ai" | "human";
  ticketStatus?: "new" | "closed" | "all";
  search?: string;
  page: number;
  perPage: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push({ path: key, message: "Unknown field" });
    }
  }
}

/** Route ids: the same pattern the Desk chatbot routes use. */
export function parseIdParam(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

export function parseStaffReplyBody(body: unknown): ParseResult<StaffReplyInput> {
  if (!isPlainObject(body)) {
    return { ok: false, issues: [{ path: "", message: "Body must be a JSON object" }] };
  }
  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(body, ["message", "isInternalNote"], issues);

  const raw = body.message;
  let message = "";
  if (typeof raw !== "string") {
    issues.push({ path: "message", message: "Message is required" });
  } else {
    message = raw.trim();
    if (message.length === 0) {
      issues.push({ path: "message", message: "Message must not be empty" });
    } else if (message.length > MAX_REPLY_LENGTH) {
      issues.push({ path: "message", message: `Message must be at most ${MAX_REPLY_LENGTH} characters` });
    }
  }

  let isInternalNote = false;
  if (body.isInternalNote !== undefined) {
    if (typeof body.isInternalNote !== "boolean") {
      issues.push({ path: "isInternalNote", message: "Must be a boolean" });
    } else {
      isInternalNote = body.isInternalNote;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { message, isInternalNote } };
}

/** Takeover and handback take no fields. An absent body is allowed. */
export function parseEmptyBody(body: unknown): ParseResult<Record<string, never>> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isPlainObject(body) || Object.keys(body).length > 0) {
    return { ok: false, issues: [{ path: "", message: "This route takes no body" }] };
  }
  return { ok: true, value: {} };
}

function parseIntParam(
  raw: unknown,
  name: string,
  fallback: number,
  max: number,
  issues: ValidationIssue[],
): number {
  if (raw === undefined) return fallback;
  const text = typeof raw === "string" ? raw : "";
  if (!/^\d+$/.test(text)) {
    issues.push({ path: name, message: "Must be a whole number" });
    return fallback;
  }
  const n = Number(text);
  if (n < 1 || n > max) {
    issues.push({ path: name, message: `Must be between 1 and ${max}` });
    return fallback;
  }
  return n;
}

export function parseInboxQuery(query: unknown): ParseResult<InboxQueryInput> {
  if (!isPlainObject(query)) {
    return { ok: false, issues: [{ path: "", message: "Query must be an object" }] };
  }
  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(query, ["handler", "status", "search", "page", "per_page"], issues);

  let handler: "ai" | "human" | undefined;
  if (query.handler !== undefined) {
    if (query.handler === "ai" || query.handler === "human") handler = query.handler;
    else issues.push({ path: "handler", message: "Must be ai or human" });
  }

  let ticketStatus: "new" | "closed" | "all" | undefined;
  if (query.status !== undefined) {
    if (query.status === "new" || query.status === "closed" || query.status === "all") {
      ticketStatus = query.status;
    } else {
      issues.push({ path: "status", message: "Must be new, closed or all" });
    }
  }

  let search: string | undefined;
  if (query.search !== undefined) {
    if (typeof query.search === "string" && query.search.length <= MAX_SEARCH_LENGTH) {
      search = query.search;
    } else {
      issues.push({ path: "search", message: `Must be a string of at most ${MAX_SEARCH_LENGTH} characters` });
    }
  }

  const page = parseIntParam(query.page, "page", 1, 100000, issues);
  const perPage = parseIntParam(query.per_page, "per_page", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, issues);

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { handler, ticketStatus, search, page, perPage } };
}
