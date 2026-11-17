/**
 * Field-service connector implementations, keyed by manifest id (#355). Pass the result to the
 * registry as `implementations`. The manifests live under server/connectors/manifests/ and are
 * registered only when their feature flag is on; everything defaults to off.
 */
import type { ConnectorDefinition } from '../sdk/contract.ts';
import { createJobberConnector } from './jobber.ts';
import { createServiceM8Connector } from './servicem8.ts';
import type { FetchLike } from './vendor-http.ts';

export interface FieldServiceOptions {
  fetch: FetchLike;
  jobberApiVersion: string;
}

export function createFieldServiceImplementations(opts: FieldServiceOptions): Map<string, ConnectorDefinition> {
  return new Map<string, ConnectorDefinition>([
    ['jobber', createJobberConnector({ fetch: opts.fetch, apiVersion: opts.jobberApiVersion })],
    ['servicem8', createServiceM8Connector({ fetch: opts.fetch })],
  ]);
}
