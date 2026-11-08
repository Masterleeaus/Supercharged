/**
 * Buy-now-pay-later rules and offer creation. Ported from BnplEligibility.php, BnplInstallmentSchedule.php and the
 * offer path of BnplRuntime.php. The provider is injected through the BnplProvider contract. No provider is called
 * here directly, and no provider key is read or stored in this file.
 */
import type { BnplOffer, BnplProvider, CommerceCredentials, CurrencyCode, FlagEnv, HttpClient } from "../../contracts/index.ts";
import { assertPositiveMinor, MoneyError, normaliseCurrency } from "./money.ts";
import { isBnplEnabled } from "./flags.ts";
import { createKeyedLock, hashRequest, requiredIdempotencyKey } from "./request-keys.ts";

export const BNPL_MIN_INSTALLMENTS = 2;
export const BNPL_MAX_INSTALLMENTS = 60;
export const BNPL_MAX_INTERVAL_DAYS = 365;

export type BnplScope = "checkout" | "rental_hire";
export type BnplShoppingMode = "native" | "marketplace_assisted";

/** One provider profile. Mirrors the BnplProviderProfile fields the eligibility rules read. */
export interface BnplPolicy {
  readonly code: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly licenceReference: string | null;
  readonly termsUrl: string | null;
  readonly hardshipUrl: string | null;
  readonly complaintsUrl: string | null;
  readonly supportedScopes: readonly string[];
  readonly supportedShoppingModes: readonly string[];
  readonly supportedCurrencies: readonly string[];
  readonly supportedCountries: readonly string[];
  readonly supportedAccountTypes: readonly string[];
  readonly minimumAmountMinor: number;
  readonly maximumAmountMinor: number | null;
  readonly installmentCounts: readonly number[];
  readonly intervalDays: number;
  readonly firstPaymentDelayDays: number;
  readonly merchantFeeBps: number;
}

export interface BnplEligibilityInput {
  readonly amountMinor: number;
  readonly currency: string;
  readonly country: string | null;
  readonly scope: BnplScope;
  readonly shoppingMode: BnplShoppingMode;
  readonly accountType: string | null;
}

export interface BnplEligibilityResult {
  readonly eligible: boolean;
  readonly displayOnly: boolean;
  readonly availability: "available" | "unavailable" | "marketplace_managed";
  readonly reason: string | null;
}

export interface InstallmentRow {
  readonly number: number;
  readonly amountMinor: number;
  readonly dueOn: string;
}

function lowerList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value !== ""))];
}

function upperList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter((value) => value !== ""))];
}

function deny(reason: string): BnplEligibilityResult {
  return { eligible: false, displayOnly: false, availability: "unavailable", reason };
}

/** Port of BnplEligibility::evaluate. Checks run in the same order as the PHP, so the first failing reason wins. */
export function evaluateBnplEligibility(policy: BnplPolicy, input: BnplEligibilityInput, requireLicensedProvider: boolean): BnplEligibilityResult {
  const currency = input.currency.trim().toUpperCase();
  const country = (input.country ?? "").trim().toUpperCase();
  const accountType = (input.accountType ?? "").trim().toLowerCase();

  if (!policy.active) return deny("provider_inactive");
  if (!lowerList(policy.supportedScopes).includes(input.scope)) return deny("scope_not_supported");
  if (!lowerList(policy.supportedShoppingModes).includes(input.shoppingMode)) return deny("shopping_mode_not_supported");
  if (requireLicensedProvider && (policy.licenceReference ?? "").trim() === "") return deny("licensed_provider_required");
  if (requireLicensedProvider && (
    (policy.termsUrl ?? "").trim() === "" || (policy.hardshipUrl ?? "").trim() === "" || (policy.complaintsUrl ?? "").trim() === ""
  )) {
    return deny("provider_disclosures_required");
  }
  if (input.amountMinor < Math.max(1, policy.minimumAmountMinor)) return deny("amount_below_minimum");
  if (policy.maximumAmountMinor !== null && policy.maximumAmountMinor > 0 && input.amountMinor > policy.maximumAmountMinor) {
    return deny("amount_above_maximum");
  }

  const currencies = upperList(policy.supportedCurrencies);
  if (currencies.length > 0 && !currencies.includes(currency)) return deny("currency_not_supported");

  const countries = upperList(policy.supportedCountries);
  if (countries.length > 0 && (country === "" || !countries.includes(country))) return deny("country_not_supported");

  if (input.scope === "rental_hire") {
    const accountTypes = lowerList(policy.supportedAccountTypes);
    if (accountTypes.length > 0 && !accountTypes.includes(accountType)) return deny("account_type_not_supported");
  }

  if (input.shoppingMode === "marketplace_assisted") {
    return { eligible: false, displayOnly: true, availability: "marketplace_managed", reason: "marketplace_checkout_owned" };
  }

  return { eligible: true, displayOnly: false, availability: "available", reason: null };
}

function addDays(isoDate: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new MoneyError("validation", "Dates must use the YYYY-MM-DD form.");
  }
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new MoneyError("validation", "Dates must use the YYYY-MM-DD form.");
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Splits amount into count instalments. Each gets the floor share, and the first (amount mod count) instalments
 * get one extra cent, so the rows always sum to the amount. Port of BnplInstallmentSchedule::build.
 */
export function installmentSchedule(amountMinor: number, count: number, intervalDays: number, firstDueOn: string): InstallmentRow[] {
  assertPositiveMinor(amountMinor, "Amount");
  if (!Number.isInteger(count) || count < BNPL_MIN_INSTALLMENTS || count > BNPL_MAX_INSTALLMENTS) {
    throw new MoneyError("validation", `The instalment count must be between ${BNPL_MIN_INSTALLMENTS} and ${BNPL_MAX_INSTALLMENTS}.`);
  }
  if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > BNPL_MAX_INTERVAL_DAYS) {
    throw new MoneyError("validation", `The instalment interval must be between 1 and ${BNPL_MAX_INTERVAL_DAYS} days.`);
  }
  const base = Math.floor(amountMinor / count);
  const remainder = amountMinor % count;
  const rows: InstallmentRow[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      number: index + 1,
      amountMinor: base + (index < remainder ? 1 : 0),
      dueOn: addDays(firstDueOn, index * intervalDays),
    });
  }
  return rows;
}

/** Fee in minor units, rounded up: ceil(amount * bps / 10000). Exact, using BigInt. */
export function merchantFeeMinor(amountMinor: number, bps: number): number {
  assertPositiveMinor(amountMinor, "Amount");
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 100_000) {
    throw new MoneyError("validation", "The merchant fee must be a whole number of basis points.");
  }
  return Number((BigInt(amountMinor) * BigInt(bps) + 9_999n) / 10_000n);
}

export interface BnplOfferRecord {
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly offer: BnplOffer;
  readonly schedule: readonly InstallmentRow[];
  readonly merchantFeeMinor: number;
}

export interface BnplOfferStorage {
  findByKey(companyId: string, idempotencyKey: string): Promise<BnplOfferRecord | null>;
  /** Returns false when the key already exists for this company. */
  insert(record: BnplOfferRecord): Promise<boolean>;
}

export function createMemoryBnplOfferStorage(): BnplOfferStorage {
  const records = new Map<string, BnplOfferRecord>();
  const slot = (companyId: string, key: string): string => `${companyId}\u0000${key}`;
  return {
    async findByKey(companyId, key) {
      return records.get(slot(companyId, key)) ?? null;
    },
    async insert(record) {
      const key = slot(record.companyId, record.idempotencyKey);
      if (records.has(key)) return false;
      records.set(key, record);
      return true;
    },
  };
}

export interface BnplSelectInput {
  readonly companyId: string;
  readonly orderRef: string;
  readonly policy: BnplPolicy;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly installmentCount: number;
  readonly scope: BnplScope;
  readonly shoppingMode: BnplShoppingMode;
  readonly accountType: string | null;
  readonly country: string | null;
  readonly customerAcceptedTerms: boolean;
  readonly idempotencyKey: string;
  /** First instalment date. Defaults to today plus the policy's first payment delay. */
  readonly firstDueOn?: string;
}

export interface BnplSelectResult {
  readonly offer: BnplOffer;
  readonly schedule: readonly InstallmentRow[];
  readonly merchantFeeMinor: number;
  readonly replayed: boolean;
}

export interface BnplServiceOptions {
  readonly provider: BnplProvider;
  readonly storage: BnplOfferStorage;
  readonly env: FlagEnv;
  readonly requireLicensedProvider?: boolean;
  readonly now?: () => Date;
}

export interface BnplService {
  offersFor(companyId: string, input: Omit<BnplEligibilityInput, "scope"> & { scope: BnplScope }, policies: readonly BnplPolicy[]): Array<{ policy: BnplPolicy; eligibility: BnplEligibilityResult }>;
  selectOffer(input: BnplSelectInput, credentials: CommerceCredentials, http: HttpClient): Promise<BnplSelectResult>;
}

export function createBnplService(options: BnplServiceOptions): BnplService {
  const requireLicensed = options.requireLicensedProvider ?? true;
  const now = options.now ?? (() => new Date());
  const withLock = createKeyedLock();

  return {
    offersFor(companyId, input, policies) {
      if (companyId.trim() === "") {
        throw new MoneyError("validation", "Company is required.");
      }
      return policies
        .map((policy) => ({ policy, eligibility: evaluateBnplEligibility(policy, input, requireLicensed) }))
        .filter((row) => row.eligibility.eligible || row.eligibility.displayOnly);
    },

    async selectOffer(input, credentials, http) {
      if (!isBnplEnabled(options.env)) {
        throw new MoneyError("disabled", "BNPL is not enabled.");
      }
      const companyId = input.companyId.trim();
      if (companyId === "") {
        throw new MoneyError("validation", "Company is required.");
      }
      const amountMinor = assertPositiveMinor(input.amountMinor, "Amount");
      const currency = normaliseCurrency(input.currency);
      if (input.shoppingMode !== "native") {
        throw new MoneyError("validation", "Marketplace-assisted BNPL must be completed in the marketplace checkout.");
      }
      if (input.customerAcceptedTerms !== true) {
        throw new MoneyError("validation", "The customer must accept the BNPL provider terms before continuing.");
      }
      const eligibility = evaluateBnplEligibility(input.policy, {
        amountMinor,
        currency,
        country: input.country,
        scope: input.scope,
        shoppingMode: input.shoppingMode,
        accountType: input.accountType,
      }, requireLicensed);
      if (!eligibility.eligible) {
        throw new MoneyError("validation", `The selected BNPL provider is unavailable: ${eligibility.reason ?? "ineligible"}.`);
      }
      if (!input.policy.installmentCounts.includes(input.installmentCount)) {
        throw new MoneyError("validation", "The selected instalment count is not offered by this provider.");
      }
      const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
      const orderRef = input.orderRef.trim();
      if (orderRef === "") {
        throw new MoneyError("validation", "Order reference is required.");
      }
      const requestHash = hashRequest({
        providerCode: input.policy.code,
        orderRef,
        amountMinor,
        currency,
        scope: input.scope,
        shoppingMode: input.shoppingMode,
        accountType: input.accountType,
        installmentCount: input.installmentCount,
      });

      return withLock(`${companyId}\u0000bnpl\u0000${idempotencyKey}`, async () => {
        const stored = await options.storage.findByKey(companyId, idempotencyKey);
        if (stored) {
          if (stored.requestHash !== requestHash) {
            throw new MoneyError("conflict", "The idempotency key was already used for another BNPL offer.");
          }
          return { offer: stored.offer, schedule: stored.schedule, merchantFeeMinor: stored.merchantFeeMinor, replayed: true };
        }

        const firstDueOn = input.firstDueOn ?? addDays(now().toISOString().slice(0, 10), Math.max(0, input.policy.firstPaymentDelayDays));
        const schedule = installmentSchedule(amountMinor, input.installmentCount, Math.max(1, input.policy.intervalDays), firstDueOn);
        const fee = merchantFeeMinor(amountMinor, Math.max(0, input.policy.merchantFeeBps));

        const offer = await options.provider.createOffer(companyId, orderRef, amountMinor, currency, input.installmentCount, credentials, http);
        if (offer.companyId !== companyId || offer.amountMinor !== amountMinor || offer.installmentCount !== input.installmentCount) {
          throw new MoneyError("state", "The BNPL provider returned an offer that does not match the request.");
        }

        const record: BnplOfferRecord = { companyId, idempotencyKey, requestHash, offer, schedule, merchantFeeMinor: fee };
        if (!(await options.storage.insert(record))) {
          throw new MoneyError("conflict", "The BNPL offer could not be stored. Retry with the same key.");
        }
        return { offer, schedule, merchantFeeMinor: fee, replayed: false };
      });
    },
  };
}
