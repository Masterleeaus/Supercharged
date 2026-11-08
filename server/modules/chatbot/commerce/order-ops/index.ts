/**
 * Order-ops entry point. Builds the services over one store and the ports the caller supplies.
 *
 *   const ops = createOrderOps({ store, native, marketplaces, writes, stock, variants, http, env: process.env });
 *
 * Off by default for anything that proposes a marketplace write: prepareCorrection refuses unless
 * CHATBOT_MARKETPLACE_WRITE_ENABLED is exactly "true". The read side (scan, import, projection, exceptions,
 * settlement, workbench) does not need that flag. Nothing here executes a refund, a send or a stock write.
 */
import type { HttpClient } from "../../contracts/index.ts";
import type { FlagEnv } from "../../contracts/index.ts";
import { createInventoryReconciliation } from "./inventory-reconciliation.ts";
import { createMarketplaceOrderImport } from "./order-import.ts";
import { createOrderProjector } from "./projector.ts";
import { createOrderExceptions } from "./exceptions.ts";
import { createOrderSettlement } from "./settlement.ts";
import { createOrderWorkbench } from "./workbench.ts";
import type { CanonicalStockReader, InventoryWriteProposer, MarketplaceRegistry, NativeOrderSource, VariantLookup } from "./ports.ts";
import type { OrderOpsStore } from "./storage.ts";

export interface OrderOpsOptions {
  store: OrderOpsStore;
  native: NativeOrderSource;
  marketplaces: MarketplaceRegistry;
  writes: InventoryWriteProposer;
  stock: CanonicalStockReader;
  variants: VariantLookup;
  http: HttpClient;
  env?: FlagEnv;
  now?: () => Date;
  fulfilmentDelaySeconds?: number;
  proposalTtlMinutes?: number;
}

export function createOrderOps(options: OrderOpsOptions) {
  const now = options.now;
  return {
    inventory: createInventoryReconciliation({
      store: options.store,
      stock: options.stock,
      variants: options.variants,
      marketplaces: options.marketplaces,
      writes: options.writes,
      http: options.http,
      now,
      env: options.env,
    }),
    orderImport: createMarketplaceOrderImport({ store: options.store, marketplaces: options.marketplaces, http: options.http, now }),
    projector: createOrderProjector({ store: options.store, now }),
    exceptions: createOrderExceptions({ store: options.store, now, fulfilmentDelaySeconds: options.fulfilmentDelaySeconds }),
    settlement: createOrderSettlement({ store: options.store, now }),
    workbench: createOrderWorkbench({
      store: options.store,
      native: options.native,
      now,
      proposalTtlMinutes: options.proposalTtlMinutes,
      fulfilmentDelaySeconds: options.fulfilmentDelaySeconds,
    }),
  };
}

export type OrderOps = ReturnType<typeof createOrderOps>;
export { createMemoryOrderOpsStore, type OrderOpsStore, type Repo, type TenantRow } from "./storage.ts";
export { createDrizzleOrderOpsStore, type DrizzleOrderOpsStoreOptions, type OrderOpsExecutor } from "./drizzle-store.ts";
export { createThreadLinker, LINK_THREAD_ACTION, type LinkThreadInput, type ThreadLinker, type ThreadLinkDeps } from "./thread-link.ts";
export {
  createCommerceLifecycle,
  createMemoryLifecycleStore,
  canLifecycleTransition,
  LIFECYCLE_EXTENSION_KEY,
  LIFECYCLE_STATUSES,
  LIFECYCLE_TRANSITIONS,
  type CommerceLifecycle,
  type LifecycleEvent,
  type LifecycleState,
  type LifecycleStateStore,
  type LifecycleStatus,
  type MemoryLifecycleStore,
} from "./lifecycle.ts";
export { canonicalStockFromFulfilment, type CanonicalStock, type CommunicationThreadPort, type CanonicalStockReader, type InventoryWriteProposer, type MarketplaceRegistry, type NativeOrderSource, type VariantLookup } from "./ports.ts";
export { OrderOpsError, type ConnectionScope } from "./types.ts";
export * from "./types.ts";
export { WORKBENCH_TOOLS, type WorkbenchActor, type WorkbenchListFilters } from "./workbench.ts";
export { allocate, assess, evaluateResolution } from "./inventory-math.ts";
export { detectExceptions, exceptionFingerprint } from "./exception-detector.ts";
export { calculateSettlement, buildSettlementReport } from "./settlement-math.ts";
