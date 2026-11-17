/**
 * PostgreSQL store for the Scheduled booking mirror (Sc3). One transaction claims the idempotency key
 * and moves the mirror forward. A stale event (older than the stored state) does not overwrite it.
 * The pool is structural so this file does not import a driver.
 */
import type { BookingEvent, ApplyOutcome, ScheduledBookingStore } from './consumer.ts';

export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}
export interface SqlPool {
  connect(): Promise<SqlClient & { release(): void }>;
}

export function createPgScheduledBookingStore(pool: SqlPool): ScheduledBookingStore {
  return {
    async apply(event: BookingEvent): Promise<ApplyOutcome> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claim = await client.query(
          `INSERT INTO scheduled_booking_events
             (company_id, idempotency_key, event_id, event_type, booking_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (company_id, idempotency_key) DO NOTHING`,
          [event.companyId, event.idempotencyKey, event.eventId, event.eventType, event.bookingId, event.occurredAt],
        );
        if (claim.rowCount !== 1) {
          await client.query('COMMIT');
          return 'duplicate';
        }
        const mirror = await client.query(
          `INSERT INTO scheduled_booking_mirror
             (company_id, booking_id, status, starts_at, ends_at, last_event_key, last_occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (company_id, booking_id) DO UPDATE SET
             status = EXCLUDED.status,
             starts_at = EXCLUDED.starts_at,
             ends_at = EXCLUDED.ends_at,
             last_event_key = EXCLUDED.last_event_key,
             last_occurred_at = EXCLUDED.last_occurred_at,
             updated_at = now()
           WHERE scheduled_booking_mirror.last_occurred_at <= EXCLUDED.last_occurred_at`,
          [event.companyId, event.bookingId, event.status, event.startsAt, event.endsAt, event.idempotencyKey, event.occurredAt],
        );
        await client.query('COMMIT');
        return mirror.rowCount === 1 ? 'applied' : 'stale';
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
