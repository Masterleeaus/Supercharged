/**
 * Reconciliation between local bookings and the provider's bookings.
 *
 * Tenant rule: only links, local appointments and provider bookings that are tied to THIS company are compared.
 * A link or appointment whose companyId differs is ignored. A provider booking that no link for this company
 * points at is counted as untracked and is never reported as a discrepancy or changed. So an event that belongs
 * to another company cannot be reconciled here, even when the same provider account is connected twice.
 *
 * reconcileBookings is pure. reconcileCalendar loads the inputs through the company-scoped stores and the
 * provider's lister, then calls it.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import type { BookingService } from "../bookings/index.ts";
import type { AppointmentRecord } from "../bookings/types.ts";
import type { CalendarConnectionRef, CalendarCredentials, CalendarProviderKey, HttpClient } from "../contracts/index.ts";
import type {
  ExternalBookingLister,
  ExternalWindow,
  ProviderLinkRecord,
  ProviderLinkStore,
  RemoteBooking,
} from "./types.ts";
import { assertWindow } from "./util.ts";

export type DiscrepancyKind = "missing_remote" | "missing_local" | "status_mismatch" | "time_mismatch";

export interface Discrepancy {
  kind: DiscrepancyKind;
  companyId: string;
  appointmentId: string;
  externalBookingId: string;
  localStatus: AppointmentRecord["status"] | null;
  remoteStatus: RemoteBooking["status"] | null;
}

export interface ReconcileResult {
  companyId: string;
  provider: CalendarProviderKey;
  /** Links for this company that were compared. */
  checked: number;
  matched: number;
  /** Provider bookings with no link for this company. Counted only, never compared. */
  untrackedRemote: number;
  discrepancies: Discrepancy[];
}

export interface ReconcileInput {
  companyId: string;
  provider: CalendarProviderKey;
  localAppointments: AppointmentRecord[];
  links: ProviderLinkRecord[];
  remote: RemoteBooking[];
}

export function reconcileBookings(input: ReconcileInput): ReconcileResult {
  const scope = requireCompanyId(input.companyId);
  const ownLinks = input.links.filter(
    (link) => link.companyId === scope && link.provider === input.provider && link.appointmentId !== null,
  );
  const localById = new Map<string, AppointmentRecord>();
  for (const appointment of input.localAppointments) {
    if (appointment.companyId === scope) localById.set(appointment.id, appointment);
  }
  const remoteById = new Map<string, RemoteBooking>();
  for (const booking of input.remote) remoteById.set(booking.externalBookingId, booking);

  const linkedRemoteIds = new Set(ownLinks.map((link) => link.externalBookingId));
  const untrackedRemote = input.remote.filter((booking) => !linkedRemoteIds.has(booking.externalBookingId)).length;

  const discrepancies: Discrepancy[] = [];
  let matched = 0;

  for (const link of ownLinks) {
    const appointmentId = link.appointmentId as string;
    const local = localById.get(appointmentId) ?? null;
    const remote = remoteById.get(link.externalBookingId) ?? null;
    const base = {
      companyId: scope,
      appointmentId,
      externalBookingId: link.externalBookingId,
      localStatus: local?.status ?? null,
      remoteStatus: remote?.status ?? null,
    };

    if (!local) {
      discrepancies.push({ ...base, kind: "missing_local" });
      continue;
    }
    // A booking that is confirmed here must be active there. Any other local status must be cancelled there.
    const expectedRemote: RemoteBooking["status"] = local.status === "confirmed" ? "active" : "cancelled";

    if (!remote) {
      if (expectedRemote === "active") discrepancies.push({ ...base, kind: "missing_remote" });
      else matched += 1;
      continue;
    }
    if (remote.status !== expectedRemote) {
      discrepancies.push({ ...base, kind: "status_mismatch" });
      continue;
    }
    if (expectedRemote === "active") {
      const sameStart = remote.startsAt.getTime() === local.startsAt.getTime();
      const sameEnd = remote.endsAt.getTime() === local.endsAt.getTime();
      if (!sameStart || !sameEnd) {
        discrepancies.push({ ...base, kind: "time_mismatch" });
        continue;
      }
    }
    matched += 1;
  }

  return {
    companyId: scope,
    provider: input.provider,
    checked: ownLinks.length,
    matched,
    untrackedRemote,
    discrepancies,
  };
}

export interface ReconcileCalendarDeps {
  companyId: string;
  provider: CalendarProviderKey;
  lister: ExternalBookingLister;
  links: ProviderLinkStore;
  bookings: Pick<BookingService, "listCalendars" | "listAppointments">;
  ref: CalendarConnectionRef;
  credentials: CalendarCredentials;
  http: HttpClient;
  window: ExternalWindow;
}

export async function reconcileCalendar(deps: ReconcileCalendarDeps): Promise<ReconcileResult> {
  const scope = requireCompanyId(deps.companyId);
  assertWindow(deps.window.from, deps.window.to);
  const [links, remote, calendars] = await Promise.all([
    deps.links.listLinks(scope, deps.provider, deps.window),
    deps.lister.listBookings(deps.ref, deps.window, deps.credentials, deps.http),
    deps.bookings.listCalendars(scope),
  ]);
  const localAppointments: AppointmentRecord[] = [];
  for (const calendar of calendars) {
    const rows = await deps.bookings.listAppointments(scope, calendar.id, {
      from: deps.window.from.toISOString(),
      to: deps.window.to.toISOString(),
    });
    localAppointments.push(...rows);
  }
  return reconcileBookings({ companyId: scope, provider: deps.provider, localAppointments, links, remote });
}
