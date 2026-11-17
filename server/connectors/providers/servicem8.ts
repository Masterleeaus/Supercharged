/**
 * ServiceM8 connector (#355). REST API (api_1.0), OAuth 2.0 (public app).
 *
 * Written against the documented contract. Open questions are recorded in the PR body: the job
 * status values, the x-record-uuid create header, the scope names and the throttling limits have
 * not been checked against a live account. Webhooks are not declared: ServiceM8 sends no payload
 * signature (only a subscribe challenge), so an inbound route needs its own design first.
 *
 * ServiceM8 documents no idempotency key for creates. Create actions are therefore single-attempt
 * writes at the caller (maxAttempts 1) so a timed-out create is not repeated blindly.
 */
import { ConnectorError, type ActionRequest, type ConnectorCredentials, type ConnectorDefinition } from '../sdk/contract.ts';
import type { EntityMapping } from '../sdk/field-mapping.ts';
import { bearerToken, callVendor, optionalString, readJson, requireString, type FetchLike } from './vendor-http.ts';

export const SERVICEM8_DEFAULT_API_URL = 'https://api.servicem8.com/api_1.0/';

/** ServiceM8 job status to canonical. Open question: confirm the status strings against a live account. */
export const SERVICEM8_JOB_STATUS_MAP: Record<string, string> = {
  Quote: 'new',
  'Work Order': 'scheduled',
  Completed: 'completed',
  Unsuccessful: 'cancelled',
};

export const SERVICEM8_JOB_MAPPING: EntityMapping = {
  fields: { id: 'uuid', title: 'job_description', customerId: 'company_uuid' },
  statusPath: 'status',
  statuses: SERVICEM8_JOB_STATUS_MAP,
};

export const SERVICEM8_CONTACT_MAPPING: EntityMapping = {
  fields: { id: 'uuid', name: 'name', email: 'email' },
};

export interface ServiceM8Options {
  fetch: FetchLike;
  apiUrl?: string;
}

export function createServiceM8Connector(opts: ServiceM8Options): ConnectorDefinition {
  const base = opts.apiUrl ?? SERVICEM8_DEFAULT_API_URL;

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    credentials: ConnectorCredentials,
    timeoutMs: number,
  ) => {
    const token = bearerToken(credentials as { type: string; accessToken?: string });
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return callVendor(opts.fetch, new URL(path, base).toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);
  };

  const getRecord = async (path: string, credentials: ConnectorCredentials, timeoutMs: number) => {
    const response = await call('GET', path, undefined, credentials, timeoutMs);
    return readJson(response);
  };

  /** ServiceM8 returns the new record's uuid in a response header, not the body. */
  const create = async (path: string, body: Record<string, unknown>, credentials: ConnectorCredentials, timeoutMs: number) => {
    const response = await call('POST', path, body, credentials, timeoutMs);
    const uuid = response.headers.get('x-record-uuid');
    if (!uuid) throw new ConnectorError('unknown', 'Vendor did not return the new record id');
    return { uuid };
  };

  return {
    id: 'servicem8',
    auth: 'oauth2',
    capabilities: ['read', 'write'],
    entities: ['contact', 'job'],
    actions: {
      getContact: { kind: 'read', entity: 'contact' },
      createContact: { kind: 'write', entity: 'contact' },
      getJob: { kind: 'read', entity: 'job' },
      createJob: { kind: 'write', entity: 'job' },
    },
    async execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
      const { action, input, timeoutMs } = request;
      switch (action) {
        case 'getContact':
          return getRecord(`company/${encodeURIComponent(requireString(input, 'id'))}.json`, credentials, timeoutMs);
        case 'createContact':
          return create(
            'company.json',
            { name: requireString(input, 'name'), email: optionalString(input, 'email') },
            credentials,
            timeoutMs,
          );
        case 'getJob':
          return getRecord(`job/${encodeURIComponent(requireString(input, 'id'))}.json`, credentials, timeoutMs);
        case 'createJob':
          return create(
            'job.json',
            {
              company_uuid: requireString(input, 'customerId'),
              job_description: optionalString(input, 'title') ?? '',
            },
            credentials,
            timeoutMs,
          );
        default:
          throw new ConnectorError('validation', `unknown action "${action}"`);
      }
    },
  };
}
