/**
 * Gateway registry. Providers register their adapter when their routes are mounted.
 * Nothing is registered while the engine flag is off.
 */

import type { GatewayAdapter } from './types';

const adapters = new Map<string, GatewayAdapter>();

export function registerGateway(adapter: GatewayAdapter): void {
  const existing = adapters.get(adapter.id);
  if (existing && existing !== adapter) {
    throw new Error(`Gateway id already registered: ${adapter.id}`);
  }
  adapters.set(adapter.id, adapter);
}

export function getGateway(id: string): GatewayAdapter | undefined {
  return adapters.get(id);
}

export function listGateways(): string[] {
  return [...adapters.keys()];
}

/** Test helper. Not called by production code. */
export function clearGatewaysForTests(): void {
  adapters.clear();
}
