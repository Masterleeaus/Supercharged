/**
 * Jobber connector (#355). GraphQL API, OAuth 2.0 (public app), HMAC-signed webhooks.
 *
 * Written against the documented contract. Open questions are recorded in the PR body: the exact
 * schema field names (jobStatus, invoiceStatus, quoteStatus, emails), the API version header value
 * and the OAuth scope names have not been checked against a live developer account.
 *
 * Writes carry no vendor idempotency key today, so a retried create after a timeout can duplicate.
 * Jobber webhooks are at-least-once: the inbound handler must be idempotent on itemId and topic.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorError, type ActionRequest, type ConnectorCredentials, type ConnectorDefinition } from '../sdk/contract.ts';
import type { EntityMapping } from '../sdk/field-mapping.ts';
import { bearerToken, callVendor, optionalString, readJson, requireString, type FetchLike } from './vendor-http.ts';

export const JOBBER_DEFAULT_API_URL = 'https://api.getjobber.com/api/graphql';

/** Jobber job status to canonical. Confirm the enum values against the live schema before enabling. */
export const JOBBER_JOB_STATUS_MAP: Record<string, string> = {
  UPCOMING: 'scheduled',
  TODAY: 'scheduled',
  ACTIVE: 'in_progress',
  LATE: 'in_progress',
  ACTION_REQUIRED: 'on_hold',
  REQUIRES_INVOICING: 'completed',
  CLOSED: 'invoiced',
  ARCHIVED: 'cancelled',
};

export const JOBBER_JOB_MAPPING: EntityMapping = {
  fields: { id: 'id', title: 'title', customerId: 'client.id' },
  statusPath: 'jobStatus',
  statuses: JOBBER_JOB_STATUS_MAP,
};

export const JOBBER_CONTACT_MAPPING: EntityMapping = {
  fields: { id: 'id', firstName: 'firstName', lastName: 'lastName', companyName: 'companyName' },
};

export interface JobberOptions {
  fetch: FetchLike;
  apiUrl?: string;
  /** Sent as the X-JOBBER-GRAPHQL-VERSION header. Open question: confirm the current value. */
  apiVersion: string;
}

const QUERIES = {
  getClient: `query GetClient($id: EncodedId!) { client(id: $id) { id firstName lastName companyName } }`,
  createClient: `mutation CreateClient($input: ClientCreateInput!) {
    clientCreate(input: $input) { client { id } userErrors { path } } }`,
  getJob: `query GetJob($id: EncodedId!) { job(id: $id) { id title jobStatus client { id } } }`,
  createJob: `mutation CreateJob($input: JobCreateAttributes!) {
    jobCreate(input: $input) { job { id jobStatus } userErrors { path } } }`,
  getQuote: `query GetQuote($id: EncodedId!) { quote(id: $id) { id quoteStatus } }`,
  getInvoice: `query GetInvoice($id: EncodedId!) { invoice(id: $id) { id invoiceStatus } }`,
} as const;

type GraphqlBody = { data?: Record<string, unknown> | null; errors?: Array<{ extensions?: { code?: string } }> };

async function graphql(
  opts: JobberOptions,
  query: string,
  variables: Record<string, unknown>,
  credentials: ConnectorCredentials,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const token = bearerToken(credentials as { type: string; accessToken?: string });
  const response = await callVendor(
    opts.fetch,
    opts.apiUrl ?? JOBBER_DEFAULT_API_URL,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-jobber-graphql-version': opts.apiVersion,
      },
      body: JSON.stringify({ query, variables }),
    },
    timeoutMs,
  );
  const body = (await readJson(response)) as GraphqlBody;
  if (body.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
    throw new ConnectorError('rate_limited', 'Vendor rate limit reached');
  }
  if (body.errors && body.errors.length > 0) throw new ConnectorError('unknown', 'Vendor returned a GraphQL error');
  return body.data ?? {};
}

/** A mutation's userErrors are a validation failure. The vendor message is never copied out. */
function userErrorsCheck(payload: unknown): void {
  const errors = (payload as { userErrors?: unknown[] } | null)?.userErrors;
  if (Array.isArray(errors) && errors.length > 0) throw new ConnectorError('validation', 'Vendor rejected the payload');
}

export function createJobberConnector(opts: JobberOptions): ConnectorDefinition {
  return {
    id: 'jobber',
    auth: 'oauth2',
    capabilities: ['read', 'write', 'webhook_in'],
    entities: ['contact', 'job', 'quote', 'invoice'],
    actions: {
      getClient: { kind: 'read', entity: 'contact' },
      createClient: { kind: 'write', entity: 'contact' },
      getJob: { kind: 'read', entity: 'job' },
      createJob: { kind: 'write', entity: 'job' },
      getQuote: { kind: 'read', entity: 'quote' },
      getInvoice: { kind: 'read', entity: 'invoice' },
    },
    async execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
      const { action, input, timeoutMs } = request;
      switch (action) {
        case 'getClient': {
          const data = await graphql(opts, QUERIES.getClient, { id: requireString(input, 'id') }, credentials, timeoutMs);
          if (!data.client) throw new ConnectorError('not_found', 'Vendor record not found');
          return data.client;
        }
        case 'createClient': {
          const data = await graphql(
            opts,
            QUERIES.createClient,
            { input: { firstName: requireString(input, 'firstName'), lastName: optionalString(input, 'lastName'), companyName: optionalString(input, 'companyName') } },
            credentials,
            timeoutMs,
          );
          const payload = data.clientCreate as { client?: unknown } | undefined;
          userErrorsCheck(payload);
          return payload?.client ?? null;
        }
        case 'getJob': {
          const data = await graphql(opts, QUERIES.getJob, { id: requireString(input, 'id') }, credentials, timeoutMs);
          if (!data.job) throw new ConnectorError('not_found', 'Vendor record not found');
          return data.job;
        }
        case 'createJob': {
          const data = await graphql(
            opts,
            QUERIES.createJob,
            { input: { clientId: requireString(input, 'customerId'), title: optionalString(input, 'title') } },
            credentials,
            timeoutMs,
          );
          const payload = data.jobCreate as { job?: unknown } | undefined;
          userErrorsCheck(payload);
          return payload?.job ?? null;
        }
        case 'getQuote': {
          const data = await graphql(opts, QUERIES.getQuote, { id: requireString(input, 'id') }, credentials, timeoutMs);
          if (!data.quote) throw new ConnectorError('not_found', 'Vendor record not found');
          return data.quote;
        }
        case 'getInvoice': {
          const data = await graphql(opts, QUERIES.getInvoice, { id: requireString(input, 'id') }, credentials, timeoutMs);
          if (!data.invoice) throw new ConnectorError('not_found', 'Vendor record not found');
          return data.invoice;
        }
        default:
          throw new ConnectorError('validation', `unknown action "${action}"`);
      }
    },
    /** Jobber signs the raw body with the app's client secret: base64 HMAC-SHA256 in X-Jobber-Hmac-SHA256. */
    verifyWebhook(rawBody: string, signature: string, secret: string): boolean {
      if (!signature || !secret) return false;
      const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
      const given = Buffer.from(signature, 'base64');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}

