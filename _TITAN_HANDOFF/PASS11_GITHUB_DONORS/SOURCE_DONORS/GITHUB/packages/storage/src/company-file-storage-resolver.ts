import {
  CompanyStorageResolutionError,
  type CompanyScopeRevalidator,
  type CompanyStorageResolverOptions,
  type VerifiedCompanyScope,
} from "./company-storage-resolver.js";
import {
  isRegisteredCompanyFilePlacement,
  type CompanyFilePlacementRegistry,
  type RegisteredCompanyFilePlacement,
} from "./company-placement-registry.js";
import type { CompanyFileStore, CompanyFileStoreOpener } from "./company-file-store-opener.js";

export interface CompanyFileStorageResolver {
  resolve(scope: VerifiedCompanyScope, options?: CompanyStorageResolverOptions): Promise<RegisteredCompanyFilePlacement>;
  open(placement: RegisteredCompanyFilePlacement, options?: CompanyStorageResolverOptions): Promise<CompanyFileStore>;
}

export interface CreateCompanyFileStorageResolverOptions {
  readonly registry: CompanyFilePlacementRegistry;
  readonly scopeRevalidator: CompanyScopeRevalidator;
  readonly opener: CompanyFileStoreOpener;
}

function companyIdForScope(scope: VerifiedCompanyScope): string {
  return scope.kind === "authenticated" ? scope.current.company_id : scope.capability.company_id;
}

function samePlacement(a: RegisteredCompanyFilePlacement, b: RegisteredCompanyFilePlacement): boolean {
  return a.company_id === b.company_id
    && a.file_placement_id === b.file_placement_id
    && a.file_placement_revision === b.file_placement_revision
    && a.provider === b.provider
    && a.schema_version === b.schema_version
    && a.status === b.status;
}

/** Resolves file placement only after server-side company scope validation.
 * References are process-local and revalidated before each new store open. */
export function createCompanyFileStorageResolver(
  options: CreateCompanyFileStorageResolverOptions,
): CompanyFileStorageResolver {
  if (!options?.registry || typeof options.registry.findFileByCompanyId !== "function"
    || !options.scopeRevalidator || typeof options.scopeRevalidator.assertCurrent !== "function"
    || !options.opener || typeof options.opener.open !== "function") {
    throw new CompanyStorageResolutionError("placement-invalid");
  }
  const issued = new WeakMap<object, VerifiedCompanyScope>();
  return Object.freeze({
    async resolve(scope: VerifiedCompanyScope, resolverOptions?: CompanyStorageResolverOptions) {
      await options.scopeRevalidator.assertCurrent(scope, resolverOptions);
      const companyId = companyIdForScope(scope);
      const placement = await options.registry.findFileByCompanyId(companyId, resolverOptions);
      if (!placement) throw new CompanyStorageResolutionError("placement-missing");
      if (!isRegisteredCompanyFilePlacement(placement) || placement.company_id !== companyId) {
        throw new CompanyStorageResolutionError("placement-company-mismatch");
      }
      if (placement.status !== "READY") throw new CompanyStorageResolutionError("placement-not-ready");
      issued.set(placement, scope);
      return placement;
    },
    async open(placement: RegisteredCompanyFilePlacement, resolverOptions?: CompanyStorageResolverOptions) {
      const scope = placement && typeof placement === "object" ? issued.get(placement) : undefined;
      if (!scope
        || !isRegisteredCompanyFilePlacement(placement)) {
        throw new CompanyStorageResolutionError("placement-reference-unrecognized");
      }
      await options.scopeRevalidator.assertCurrent(scope, resolverOptions);
      if (companyIdForScope(scope) !== placement.company_id) {
        throw new CompanyStorageResolutionError("placement-company-mismatch");
      }
      const current = await options.registry.findFileByCompanyId(placement.company_id, resolverOptions);
      if (!current || !isRegisteredCompanyFilePlacement(current) || !samePlacement(current, placement)) {
        throw new CompanyStorageResolutionError("placement-stale");
      }
      if (current.status !== "READY") throw new CompanyStorageResolutionError("placement-not-ready");
      return options.opener.open(current);
    },
  });
}
