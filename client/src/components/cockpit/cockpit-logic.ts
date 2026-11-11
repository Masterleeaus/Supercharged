/**
 * Pure cockpit logic: panel layout per mode, card sorting, card button routing,
 * filtering, desk mode resolution and wire-to-card mapping. No React, no network, no app
 * imports, so node --test can load it directly.
 */
import { DEFAULT_DESK_MODE, parseDeskMode, type DeskMode } from "./desk-mode.ts";

export type CockpitPanelId =
  | "workforce_activity"
  | "needs_attention"
  | "inbox"
  | "campaign_responses";

export type CockpitSortOrder = "newest" | "oldest" | "kind";

export const COCKPIT_SORT_ORDERS: readonly CockpitSortOrder[] = ["newest", "oldest", "kind"];

/**
 * The suggested action of a card. The card button runs it.
 * - approve: approves the approval with this id (approvals-api approveApproval)
 * - open: navigates to href (only routes that exist in the app)
 */
export type CockpitAction =
  | { kind: "approve"; label: string; approvalId: string }
  | { kind: "open"; label: string; href: string };

export interface CockpitItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  /** ISO 8601 time, or null when unknown. Unknown times sort last in both time orders. */
  createdAt: string | null;
  /** Route to open when the card body is clicked. Null means the body click does nothing. */
  openHref: string | null;
  /** Omitted when no endpoint or route performs an action. No button then. */
  action?: CockpitAction;
}

/** Panels shown for each mode: workforce shows the workforce panels, comms the communications panels. */
export function panelsForMode(mode: DeskMode): [CockpitPanelId, CockpitPanelId] {
  return mode === "comms"
    ? ["inbox", "campaign_responses"]
    : ["workforce_activity", "needs_attention"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeOf(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function byId(a: CockpitItem, b: CockpitItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byNewest(a: CockpitItem, b: CockpitItem): number {
  const aMs = timeOf(a.createdAt);
  const bMs = timeOf(b.createdAt);
  if (aMs === null && bMs === null) return byId(a, b);
  if (aMs === null) return 1;
  if (bMs === null) return -1;
  return bMs - aMs || byId(a, b);
}

function byOldest(a: CockpitItem, b: CockpitItem): number {
  const aMs = timeOf(a.createdAt);
  const bMs = timeOf(b.createdAt);
  if (aMs === null && bMs === null) return byId(a, b);
  if (aMs === null) return 1;
  if (bMs === null) return -1;
  return aMs - bMs || byId(a, b);
}

/**
 * Returns a sorted copy. The input is not changed.
 * - newest: latest createdAt first
 * - oldest: earliest createdAt first
 * - kind: kind A to Z, then newest first within each kind
 * Items with an unknown time go last in both time orders.
 */
export function sortCockpitItems(items: readonly CockpitItem[], order: CockpitSortOrder): CockpitItem[] {
  const copy = [...items];
  if (order === "oldest") return copy.sort(byOldest);
  if (order === "kind") {
    return copy.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      return byNewest(a, b);
    });
  }
  return copy.sort(byNewest);
}

// ---- card gestures ----

export type CardGesture = "button" | "body";

export interface CardHandlers {
  onOpen: (item: CockpitItem) => void;
  /** Runs the suggested action. The card button calls this. */
  onAction: (item: CockpitItem) => void;
}

/**
 * Routes one card gesture.
 * - button runs the suggested action through onAction. With no action, nothing runs.
 * - body opens the item only when it has an openHref.
 * Cockpit cards have no swipe gestures; swipe belongs to the activity stream only.
 */
export function routeCardGesture(gesture: CardGesture, item: CockpitItem, handlers: CardHandlers): void {
  if (gesture === "button") {
    if (item.action) handlers.onAction(item);
    return;
  }
  if (item.openHref) handlers.onOpen(item);
}

// ---- desk mode ----

export type DeskModeOutcome = { ok: true; body: unknown } | { ok: false; reason: string };

export interface ResolvedDeskMode {
  mode: DeskMode;
  /** Shown as a small notice when the mode could not be read. Null when it was read. */
  notice: string | null;
}

/** Resolves the mode from the GET /api/desk-mode outcome. A failed or invalid read uses the default mode. */
export function resolveDeskMode(outcome: DeskModeOutcome): ResolvedDeskMode {
  if (outcome.ok === false) {
    return {
      mode: DEFAULT_DESK_MODE,
      notice: `Could not read the desk mode (${outcome.reason}). Showing workforce panels.`,
    };
  }
  const mode = isRecord(outcome.body) ? parseDeskMode(outcome.body.mode) : null;
  if (mode) return { mode, notice: null };
  return {
    mode: DEFAULT_DESK_MODE,
    notice: "Could not read the desk mode (invalid response). Showing workforce panels.",
  };
}

// ---- wire helpers ----

/** Roles that may read workforce activity. Members get a 403 from the endpoint, so the panel is hidden for them. */
const WORKFORCE_ACTIVITY_ROLES: readonly string[] = ["admin", "manager"];

export function canSeeWorkforceActivity(role: string | null | undefined): boolean {
  return typeof role === "string" && WORKFORCE_ACTIVITY_ROLES.includes(role);
}

/** The list under `items` of a response body, or a bare array body. Anything else is an empty list. */
export function listFromBody(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.items)) return body.items;
  return [];
}

/** A short source caption from a response field such as runsSource or eventsSource. */
export function sourceNote(body: unknown, field: string): string | null {
  if (!isRecord(body)) return null;
  const value = body[field];
  return typeof value === "string" && value.trim() !== "" ? `Source: ${value}` : null;
}

function humanise(kind: string): string {
  const spaced = kind.replace(/_/g, " ").trim();
  return spaced === "" ? "Activity" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isAppPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/app/") && !value.startsWith("//");
}

// ---- wire mappers (structural input types) ----

export interface WorkforceActivityLike {
  id: string;
  kind: string;
  title: string;
  detail: string;
  createdAt: string;
  suggestedAction?: { label?: string; approvalId: string } | null;
}

/** GET /api/workforce/activity items. Completed work has no action; needs_approval items carry an approve action. */
export function mapWorkforceActivityToItems(rows: readonly unknown[]): CockpitItem[] {
  const out: CockpitItem[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const kind = typeof row.kind === "string" && row.kind !== "" ? row.kind : "activity";
    const suggested = isRecord(row.suggestedAction) ? row.suggestedAction : null;
    const approvalId = suggested && typeof suggested.approvalId === "string" ? suggested.approvalId : "";
    const label = suggested && typeof suggested.label === "string" && suggested.label !== ""
      ? suggested.label
      : "Approve and run";
    out.push({
      id: `activity:${row.id}`,
      kind,
      title: typeof row.title === "string" && row.title !== "" ? row.title : humanise(kind),
      detail: typeof row.detail === "string" && row.detail !== "" ? row.detail : "No detail",
      createdAt: typeof row.createdAt === "string" && row.createdAt !== "" ? row.createdAt : null,
      openHref: null,
      ...(approvalId ? { action: { kind: "approve" as const, label, approvalId } } : {}),
    });
  }
  return out;
}

export interface ReviewItemLike {
  id: string;
  kind: string;
  reason: string;
  createdAt: string;
  approvalId?: string;
  /** A run page link, when the review item carries one. No current item does. */
  runHref?: string | null;
}

/**
 * GET /api/workforce/review-inbox items.
 * - approval_* items get an "Open approvals" button to /app/approvals.
 * - run_needs_attention items get "Open run" only when the item links to a run page under /app/.
 * - every other kind gets no button.
 */
export function mapReviewInboxToItems(rows: readonly unknown[]): CockpitItem[] {
  const out: CockpitItem[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const kind = typeof row.kind === "string" && row.kind !== "" ? row.kind : "review";
    const runHref = isAppPath(row.runHref) ? row.runHref : null;
    const approvalType = kind.startsWith("approval_");
    let action: CockpitAction | undefined;
    if (approvalType) {
      action = { kind: "open", label: "Open approvals", href: "/app/approvals" };
    } else if (kind === "run_needs_attention" && runHref) {
      action = { kind: "open", label: "Open run", href: runHref };
    }
    out.push({
      id: `review:${row.id}`,
      kind,
      title: humanise(kind),
      detail: typeof row.reason === "string" && row.reason !== "" ? row.reason : "No reason given",
      createdAt: typeof row.createdAt === "string" && row.createdAt !== "" ? row.createdAt : null,
      openHref: approvalType ? "/app/approvals" : runHref,
      ...(action ? { action } : {}),
    });
  }
  return out;
}

/** Thread records from GET /api/inbox/threads. Only open threads become cards. */
export function mapThreadsToInboxItems(rows: readonly unknown[]): CockpitItem[] {
  const out: CockpitItem[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    // Call records are never inbox threads: they carry phone or direction fields and no channel.
    if ("phoneNumber" in row || "callDirection" in row) continue;
    if (typeof row.channel !== "string" || row.channel === "") continue;
    if (row.status !== "open") continue;
    const subject = typeof row.subject === "string" && row.subject.trim() !== "" ? row.subject : null;
    const when = typeof row.lastMessageAt === "string" ? row.lastMessageAt : typeof row.createdAt === "string" ? row.createdAt : null;
    out.push({
      id: `thread:${row.id}`,
      kind: row.channel,
      title: subject ?? `${row.channel} conversation`,
      detail: "Open thread",
      createdAt: when,
      openHref: null,
    });
  }
  return out;
}

/** Campaign response records from GET /api/campaigns/responses. */
export function mapCampaignResponsesToItems(rows: readonly unknown[]): CockpitItem[] {
  const out: CockpitItem[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const who = typeof row.contactName === "string" && row.contactName !== "" ? row.contactName : "Contact";
    const campaign = typeof row.campaignName === "string" && row.campaignName !== "" ? row.campaignName : null;
    const summary = typeof row.summary === "string" && row.summary !== "" ? row.summary : null;
    out.push({
      id: `campaign-response:${row.id}`,
      kind: "response",
      title: campaign ? `${who} replied to ${campaign}` : `${who} replied`,
      detail: summary ?? "No message text recorded",
      createdAt: typeof row.createdAt === "string" && row.createdAt !== "" ? row.createdAt : null,
      openHref: null,
    });
  }
  return out;
}
