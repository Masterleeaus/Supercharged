/**
 * Carrier seam. Rate lookups and label printing are out of scope for this port. The Commerce Crew
 * extension calls carrier APIs from ShippingProvider and the label flow. Here they sit behind this
 * interface, and the default is a no-op that returns no rates and no label.
 */
import type { Id } from "./types.ts";

export interface CarrierRateRequest {
  fulfilmentId: Id;
  weightGrams: number;
  destinationCountry: string;
  destinationPostcode: string;
}

export interface CarrierRate {
  carrier: string;
  service: string;
  amountMinor: number;
  currency: string;
}

export interface CarrierLabelRequest {
  fulfilmentId: Id;
  carrier: string;
  service: string;
}

export interface CarrierLabel {
  trackingNumber: string;
  labelUrl: string;
}

export interface CarrierGateway {
  quoteRates(request: CarrierRateRequest): Promise<CarrierRate[]>;
  printLabel(request: CarrierLabelRequest): Promise<CarrierLabel | null>;
}

/** Default implementation. No carrier is contacted and no label is produced. */
export const noopCarrierGateway: CarrierGateway = {
  async quoteRates() {
    return [];
  },
  async printLabel() {
    return null;
  },
};
