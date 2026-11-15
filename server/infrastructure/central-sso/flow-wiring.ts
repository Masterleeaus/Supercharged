/** Composes the Central OIDC flow with the database-backed pending-login store.
 * Behind CENTRAL_SSO_ENABLED: when the config is disabled, no database handle is
 * needed or touched, and start()/complete() return 'disabled' as before.
 * When enabled, every process shares the pending-login table (migration 0019), so
 * the in-memory store is not used. Store errors fail closed: start() reports
 * session_unavailable and complete() reports unknown_state. Not mounted on any route.
 */
import type {CentralSsoConfig} from './config.ts';
import type {FetchLike, Jwk, OidcMetadata} from './discovery.ts';
import {createCentralOidcFlow, type PendingStore} from './oidc-flow.ts';
import {createDatabasePendingStore, type PendingQueryable} from './pending-store-db.ts';
import type {RandomBytes} from './pkce.ts';

export type CentralSsoFlowDeps = {
 config: CentralSsoConfig;
 discovery: () => Promise<OidcMetadata>;
 jwksKeys: (kid: string) => Promise<Jwk | null>;
 /** pg-compatible handle to the app database. Required when config.enabled is true. */
 db?: PendingQueryable;
 fetchImpl?: FetchLike;
 clock?: () => number;
 random?: RandomBytes;
};

/** Never reached while disabled: the flow returns 'disabled' before it touches the store. */
const REFUSING_STORE: PendingStore = {
 put: () => false,
 take: () => null,
};

function failClosed(store: PendingStore): PendingStore {
 return {
  async put(state, record, ttlMs) {
   try {
    return await store.put(state, record, ttlMs);
   } catch {
    return false;
   }
  },
  async take(state) {
   try {
    return await store.take(state);
   } catch {
    return null;
   }
  },
 };
}

export function createCentralSsoFlow({config, discovery, jwksKeys, db, fetchImpl, clock, random}: CentralSsoFlowDeps) {
 let pending: PendingStore = REFUSING_STORE;
 if (config.enabled) {
  if (!db) throw new Error('central-sso: a database handle is required for the pending-login store');
  pending = failClosed(createDatabasePendingStore({db}));
 }
 return createCentralOidcFlow({config, discovery, jwksKeys, pending, fetchImpl, clock, random});
}
