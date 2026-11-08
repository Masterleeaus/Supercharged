/**
 * Health check for the bookings slice. Port of ExtensionHealthService.php. The probe is injected, so the
 * slice never opens a database connection itself. A failing probe reports "unavailable" and does not
 * return the raw error text, which the PHP did.
 */
export interface BookingHealth {
  ok: boolean;
  extension: "chatbot-booking";
  checks: { database: boolean; configuration: boolean };
  timestamp: string;
}

export async function bookingHealth(
  probe: () => Promise<unknown>,
  configured: boolean,
  now: Date = new Date(),
): Promise<BookingHealth> {
  let database = false;
  try {
    await probe();
    database = true;
  } catch {
    database = false;
  }
  return {
    ok: database && configured,
    extension: "chatbot-booking",
    checks: { database, configuration: configured },
    timestamp: now.toISOString(),
  };
}
