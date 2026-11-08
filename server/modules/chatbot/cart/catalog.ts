/**
 * Catalog port for the cart. The product module is out of scope for this slice, so the cart reads
 * variants through this interface only. createMemoryCartCatalog() serves tests and local runs.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import { assertMinorAmount } from "./money.ts";

export interface CatalogVariant {
  readonly variantId: string;
  readonly productId: string;
  readonly chatbotId: string;
  readonly sku: string | null;
  readonly name: string;
  readonly currency: string;
  readonly unitPriceMinor: number;
  readonly active: boolean;
}

export interface CartCatalog {
  /** Returns the variant for this company, or null. Callers must still check active and chatbot. */
  findVariant(companyId: string, variantId: string): Promise<CatalogVariant | null>;
}

export function createMemoryCartCatalog(variants: readonly CatalogVariant[] = [], companyId?: string): CartCatalog & {
  add(companyId: string, variant: CatalogVariant): void;
} {
  const byCompany = new Map<string, Map<string, CatalogVariant>>();

  function add(tenant: string, variant: CatalogVariant): void {
    const scoped = requireCompanyId(tenant);
    assertMinorAmount(variant.unitPriceMinor, "Unit price");
    let rows = byCompany.get(scoped);
    if (!rows) {
      rows = new Map();
      byCompany.set(scoped, rows);
    }
    rows.set(variant.variantId, variant);
  }

  if (companyId !== undefined) {
    for (const variant of variants) {
      add(companyId, variant);
    }
  }

  return {
    add,
    async findVariant(tenant, variantId) {
      return byCompany.get(requireCompanyId(tenant))?.get(variantId) ?? null;
    },
  };
}
