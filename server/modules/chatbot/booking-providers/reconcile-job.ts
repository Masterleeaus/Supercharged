/**
 * Reconciliation as one call a worker can make per company. It reports discrepancies and changes nothing.
 *
 * The worker passes a company id and a loader for that company's connection. The loader is the only place that
 * credentials come from. A connection whose company id or provider does not match the request is refused before
 * any provider call, so a loader bug cannot reconcile another company's bookings.
 *
 * Outcomes are returned, not thrown, so a worker can run many companies in a loop. Errors carry a code, never a
 * message from the provider, a URL, or a credential.
 */
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import type { BookingService } from "../bookings/index.ts";
import type { CalendarConnectionRef, CalendarCredentials, CalendarProviderKey, HttpClient } from "../contracts/index.ts";
import { CalendarProviderError, type ProviderErrorCode } from "./errors.ts";
import { reconcileCalendar, type ReconcileResult } from "./reconcile.ts";
import type { ExternalBookingLister, ExternalWindow, ProviderLinkStore } from "./types.ts";

const DAY_MS = 86_400_000;
/** Bookings from the last day are checked, so a recent cancel is not missed. */
export const RECONCILE_LOOKBACK_DAYS = 1;
/** Bookings up to 30 days ahead are checked. */
export const RECONCILE_LOOKAHEAD_DAYS = 30;

export interface ReconciliationConnection {
  ref: CalendarConnectionRef;
  credentials: CalendarCredentials;
}

export interface ReconciliationJobDeps {
  provider: CalendarProviderKey;
  lister: ExternalBookingLister;
  links: ProviderLinkStore;
  bookings: Pick<BookingService, "listCalendars" | "listAppointments">;
  http: HttpClient;
  /** Loads this company's connection for the provider. Returns null when the company has none. */
  loadConnection: (companyId: string) => Promise<ReconciliationConnection | null>;
  now?: () => Date;
}

export type ReconciliationOutcome =
  | { status: "reconciled"; result: ReconcileResult }
  | { status: "not_connected" }
  | { status: "failed"; code: ProviderErrorCode | "disabled" | "config" | "internal" };

export async function runReconciliationJob(companyId: string, deps: ReconciliationJobDeps): Promise<ReconciliationOutcome> {
  const scope = requireCompanyId(companyId);
  const connection = await deps.loadConnection(scope);
  if (!connection) return { status: "not_connected" };
  if (connection.ref.companyId !== scope || connection.ref.provider !== deps.provider) {
    return { status: "failed", code: "config" };
  }

  const now = (deps.now ?? (() => new Date()))();
  const window: ExternalWindow = {
    from: new Date(now.getTime() - RECONCILE_LOOKBACK_DAYS * DAY_MS),
    to: new Date(now.getTime() + RECONCILE_LOOKAHEAD_DAYS * DAY_MS),
  };

  try {
    const result = await reconcileCalendar({
      companyId: scope,
      provider: deps.provider,
      lister: deps.lister,
      links: deps.links,
      bookings: deps.bookings,
      ref: connection.ref,
      credentials: connection.credentials,
      http: deps.http,
      window,
    });
    return { status: "reconciled", result };
  } catch (error) {
    if (error instanceof CalendarProviderError) return { status: "failed", code: error.code };
    if (error instanceof ChatbotError && error.status === 503) return { status: "failed", code: "disabled" };
    return { status: "failed", code: "internal" };
  }
}
