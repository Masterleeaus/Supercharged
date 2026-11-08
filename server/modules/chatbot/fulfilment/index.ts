/**
 * Fulfilment module entry point. Off by default. It is enabled only when CHATBOT_FULFILMENT_ENABLED
 * is exactly "true", the same check the Desk module uses for its other flags.
 */
import { ChatbotError } from "../chatbot-scope.ts";
import { type CarrierGateway, noopCarrierGateway } from "./carrier-gateway.ts";
import { createFulfilmentService, type FulfilmentService } from "./fulfilment-service.ts";
import type { FulfilmentStorage } from "./fulfilment-storage.ts";
import { createInventoryService, type InventoryService } from "./inventory.ts";
import type { ServiceClock } from "./types.ts";

export const FULFILMENT_FLAG = "CHATBOT_FULFILMENT_ENABLED";

export type FlagEnv = Record<string, string | undefined>;

export function isFulfilmentEnabled(env: FlagEnv = process.env): boolean {
  return env[FULFILMENT_FLAG] === "true";
}

export interface FulfilmentModuleOptions {
  storage: FulfilmentStorage;
  /** Defaults to process.env. Tests pass their own object. */
  env?: FlagEnv;
  clock?: Partial<ServiceClock>;
  requireTrackingForDelivery?: boolean;
  carrier?: CarrierGateway;
}

export interface FulfilmentModule {
  inventory: InventoryService;
  fulfilment: FulfilmentService;
  carrier: CarrierGateway;
}

/** Throws a 404 when the flag is off, so the module cannot be reached by accident. */
export function createFulfilmentModule(options: FulfilmentModuleOptions): FulfilmentModule {
  if (!isFulfilmentEnabled(options.env ?? process.env)) {
    throw new ChatbotError("Fulfilment module is disabled.", 404);
  }
  return {
    inventory: createInventoryService({ storage: options.storage, clock: options.clock }),
    fulfilment: createFulfilmentService({
      storage: options.storage,
      clock: options.clock,
      requireTrackingForDelivery: options.requireTrackingForDelivery,
    }),
    carrier: options.carrier ?? noopCarrierGateway,
  };
}

export { createMemoryFulfilmentStorage, type FulfilmentStorage } from "./fulfilment-storage.ts";
export { createInventoryService, type InventoryService, type StockView, type ReserveInput, type AdjustInput } from "./inventory.ts";
export {
  createFulfilmentService,
  type FulfilmentService,
  type CreateFulfilmentInput,
  type RegisterOrderInput,
  type FulfilmentSummary,
  type TrackingInput,
} from "./fulfilment-service.ts";
export { noopCarrierGateway, type CarrierGateway } from "./carrier-gateway.ts";
export * from "./types.ts";
export { availableUnits, aggregateFulfilment, canTransitionFulfilment, canTransitionReservation } from "./state.ts";
