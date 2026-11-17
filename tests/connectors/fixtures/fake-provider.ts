/**
 * In-repo fake vendor for connector contract tests. No network: it is a scripted object.
 * Scripting: queue faults with failNext(); each queued fault is consumed by one execute() call.
 * Writes are idempotent by key, the way a real vendor's Idempotency-Key header behaves.
 */
import { ConnectorError, errorFromStatus, type ActionRequest, type ConnectorCredentials, type ConnectorDefinition } from '../../../server/connectors/sdk/contract.ts';

export type Fault = { status: number; retryAfterMs?: number } | { timeoutMs: number };

export interface FakeProvider extends ConnectorDefinition {
  failNext(fault: Fault): void;
  readonly calls: number;
  readonly bookingsCreated: number;
  readonly seenKeys: string[];
  reset(): void;
}

export const FAKE_API_KEY = 'fake-api-key-value';

const CONTACTS: Record<string, unknown> = {
  c1: { id: 'c1', contact: { display_name: 'Ada Example', email_address: 'ada@example.test' }, state: 'ACTIVE' },
};

export function createFakeProvider(): FakeProvider {
  let faults: Fault[] = [];
  let calls = 0;
  let bookings = 0;
  const seenKeys: string[] = [];
  const created = new Map<string, unknown>();

  const provider: FakeProvider = {
    id: 'fake-crm',
    auth: 'api_key',
    capabilities: ['read', 'write'],
    entities: ['contact', 'booking'],
    actions: {
      getContact: { kind: 'read', entity: 'contact' },
      createBooking: { kind: 'write', entity: 'booking' },
    },
    failNext(fault) {
      faults.push(fault);
    },
    get calls() {
      return calls;
    },
    get bookingsCreated() {
      return bookings;
    },
    get seenKeys() {
      return seenKeys;
    },
    reset() {
      faults = [];
      calls = 0;
      bookings = 0;
      seenKeys.length = 0;
      created.clear();
    },
    async execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
      calls += 1;
      const fault = faults.shift();
      if (fault && 'timeoutMs' in fault) {
        await new Promise((resolve) => setTimeout(resolve, fault.timeoutMs));
        return null;
      }
      if (fault) throw errorFromStatus(fault.status, fault.retryAfterMs);

      if (credentials.type !== 'api_key' || credentials.apiKey !== FAKE_API_KEY) {
        throw new ConnectorError('auth', 'Vendor rejected the credentials');
      }

      if (request.action === 'getContact') {
        const input = request.input as { id?: unknown };
        const record = typeof input.id === 'string' ? CONTACTS[input.id] : undefined;
        if (!record) throw new ConnectorError('not_found', 'Vendor record not found');
        return record;
      }

      if (request.action === 'createBooking') {
        const key = request.idempotencyKey;
        if (!key) throw new ConnectorError('validation', 'write needs an idempotency key');
        seenKeys.push(key);
        if (created.has(key)) return created.get(key);
        bookings += 1;
        const result = { id: `b${bookings}`, status: 'CONFIRMED' };
        created.set(key, result);
        return result;
      }

      throw new ConnectorError('validation', 'unknown action');
    },
  };
  return provider;
}
