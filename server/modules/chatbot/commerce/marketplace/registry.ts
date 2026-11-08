/**
 * Provider registries keyed by marketplace provider. Port of MarketplaceProviderRegistry.php and
 * MarketplaceWriteProviderRegistry.php. The registries hold provider objects that the caller supplies, so no
 * vendor code is imported here. Keys are normalised (trim, lower case) and must be one of the contract keys.
 */
import {
  MARKETPLACE_PROVIDER_KEYS,
  type MarketplaceCapability,
  type MarketplaceProvider,
  type MarketplaceProviderKey,
  type MarketplaceWriteOps,
} from "../../contracts/index.ts";
import { MarketplaceError } from "./errors.ts";

export function normaliseProviderKey(key: string): MarketplaceProviderKey {
  const value = String(key).trim().toLowerCase();
  if (!(MARKETPLACE_PROVIDER_KEYS as readonly string[]).includes(value)) {
    throw new MarketplaceError("unsupported_provider", "Unsupported marketplace provider.");
  }
  return value as MarketplaceProviderKey;
}

export interface MarketplaceReadRegistry {
  get(key: string): MarketplaceProvider;
  /** Keys that have a registered provider, in contract order. */
  keys(): MarketplaceProviderKey[];
  /** Union of the provider's capabilities. Pure: no companyId. */
  capabilities(key: string): MarketplaceCapability[];
}

export interface MarketplaceWriteRegistry {
  /** Returns the write operations for a provider. Throws read_only_provider when the provider has none. */
  get(key: string): MarketplaceWriteOps;
  hasWrite(key: string): boolean;
}

export function createMarketplaceReadRegistry(
  providers: Partial<Record<MarketplaceProviderKey, MarketplaceProvider>>,
): MarketplaceReadRegistry {
  const registered = (key: string): MarketplaceProvider => {
    const normalised = normaliseProviderKey(key);
    const provider = providers[normalised];
    if (provider === undefined) throw new MarketplaceError("unsupported_provider", "Unsupported marketplace provider.");
    if (provider.key !== normalised) throw new MarketplaceError("provider_mismatch", "Provider registered under the wrong key.");
    return provider;
  };
  return {
    get: registered,
    keys: () => MARKETPLACE_PROVIDER_KEYS.filter((key) => providers[key] !== undefined),
    capabilities: (key) => [...new Set(registered(key).capabilities())],
  };
}

export function createMarketplaceWriteRegistry(
  providers: Partial<Record<MarketplaceProviderKey, MarketplaceProvider>>,
): MarketplaceWriteRegistry {
  const registered = (key: string): MarketplaceProvider => {
    const normalised = normaliseProviderKey(key);
    const provider = providers[normalised];
    if (provider === undefined) throw new MarketplaceError("unsupported_provider", "Unsupported marketplace provider.");
    if (provider.key !== normalised) throw new MarketplaceError("provider_mismatch", "Provider registered under the wrong key.");
    return provider;
  };
  return {
    get(key) {
      const provider = registered(key);
      if (provider.write === null) throw new MarketplaceError("read_only_provider", "This marketplace is read-only.");
      return provider.write;
    },
    hasWrite: (key) => {
      try {
        return registered(key).write !== null;
      } catch {
        return false;
      }
    },
  };
}
