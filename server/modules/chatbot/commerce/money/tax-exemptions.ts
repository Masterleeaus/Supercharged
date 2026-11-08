/**
 * Tax exemption records. Ported from TaxRuntime.php (isExempt, resolveContext) and the TaxExemption model.
 *
 * A record is bound either to an exemption key (a certificate number that whoever presents it may use) or to one
 * customer reference. A customer-bound record never applies to any other customer. A record may name a tax class
 * ("shipping", "default", ...) so it exempts only that class. A record with no tax class exempts the whole order.
 *
 * The PHP matched key OR customer in one query. The port keeps the same two bindings, but a record matches only the
 * binding it was created with, so a customer-bound record cannot leak to another customer.
 *
 * Tenancy: every method takes companyId first. A row from another company is treated as absent.
 */
import { MoneyError } from "./money.ts";

export const SHIPPING_TAX_CLASS = "shipping";
export const DEFAULT_TAX_CLASS = "default";

export interface TaxExemptionRecord {
  readonly companyId: string;
  readonly id: string;
  /** Certificate or exemption key. Null when the record is bound to a customer. */
  readonly exemptionKey: string | null;
  /** Customer reference. Null when the record is bound to an exemption key. */
  readonly customerRef: string | null;
  /** Null exempts the whole order. A class exempts only lines and shipping in that class. */
  readonly taxClass: string | null;
  readonly reason: string | null;
  readonly active: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly createdAt: Date;
}

export interface TaxExemptionSubject {
  readonly exemptionKey: string | null;
  readonly customerRef: string | null;
}

export interface TaxExemptionStorage {
  /** Active records for the company whose window covers `at` and whose binding matches the subject. */
  findMatching(companyId: string, subject: TaxExemptionSubject, at: Date): Promise<TaxExemptionRecord[]>;
  /** Returns false when the id already exists for this company. */
  insert(record: TaxExemptionRecord): Promise<boolean>;
  deactivate(companyId: string, id: string, now: Date): Promise<boolean>;
}

export interface TaxExemptionFields {
  readonly exemptionKey?: string | null;
  readonly customerRef?: string | null;
  readonly taxClass?: string | null;
  readonly reason?: string | null;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
}

function trimmedOrNull(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new MoneyError("validation", `A value is limited to ${max} characters.`);
  }
  return trimmed === "" ? null : trimmed;
}

/** Builds a valid record. A record needs an exemption key or a customer reference, and not both. */
export function buildTaxExemption(companyId: string, id: string, fields: TaxExemptionFields, now: Date): TaxExemptionRecord {
  const tenant = companyId.trim();
  if (tenant === "") {
    throw new MoneyError("validation", "Company is required.");
  }
  const exemptionKey = trimmedOrNull(fields.exemptionKey, 191);
  const customerRef = trimmedOrNull(fields.customerRef, 191);
  if ((exemptionKey === null) === (customerRef === null)) {
    throw new MoneyError("validation", "A tax exemption needs exactly one of an exemption key or a customer reference.");
  }
  const startsAt = fields.startsAt ?? null;
  const endsAt = fields.endsAt ?? null;
  if (startsAt && endsAt && endsAt < startsAt) {
    throw new MoneyError("validation", "The exemption end date cannot be before its start date.");
  }
  return {
    companyId: tenant,
    id,
    exemptionKey,
    customerRef,
    taxClass: trimmedOrNull(fields.taxClass, 64)?.toLowerCase() ?? null,
    reason: trimmedOrNull(fields.reason, 191),
    active: true,
    startsAt,
    endsAt,
    createdAt: now,
  };
}

/** True when the record's binding matches the subject and its window covers `at`. Pure. */
export function exemptionApplies(record: TaxExemptionRecord, subject: TaxExemptionSubject, at: Date): boolean {
  if (!record.active) return false;
  if (record.startsAt && record.startsAt > at) return false;
  if (record.endsAt && record.endsAt < at) return false;
  const keyMatch = record.exemptionKey !== null && subject.exemptionKey !== null && record.exemptionKey === subject.exemptionKey;
  const customerMatch = record.customerRef !== null && subject.customerRef !== null && record.customerRef === subject.customerRef;
  return keyMatch || customerMatch;
}

/** What the matching records exempt for one order. */
export interface TaxExemptionDecision {
  /** True when a record with no tax class, or the order flag, exempts the whole order. */
  readonly wholeOrder: boolean;
  /** Tax classes exempted by the matching records. */
  readonly taxClasses: readonly string[];
  readonly matchedIds: readonly string[];
  /** True when a line in this tax class pays no tax. Pass null for the default class. */
  taxClassExempt(taxClass: string | null): boolean;
  shippingExempt(): boolean;
}

/** Combines the matching records with the order-level flag into one decision. */
export function decideTaxExemption(records: readonly TaxExemptionRecord[], subject: TaxExemptionSubject, at: Date, orderExempt: boolean): TaxExemptionDecision {
  const matching = records.filter((record) => exemptionApplies(record, subject, at));
  const wholeOrder = orderExempt || matching.some((record) => record.taxClass === null);
  const classes = [...new Set(matching.map((record) => record.taxClass).filter((value): value is string => value !== null))];
  return {
    wholeOrder,
    taxClasses: classes,
    matchedIds: matching.map((record) => record.id),
    taxClassExempt: (taxClass) => wholeOrder || (taxClass !== null && classes.includes(taxClass.trim().toLowerCase())),
    shippingExempt: () => wholeOrder || classes.includes(SHIPPING_TAX_CLASS),
  };
}

/** Loads the matching records through storage, then decides. A subject with no key and no customer exempts nothing. */
export async function resolveTaxExemption(
  storage: TaxExemptionStorage,
  companyId: string,
  subject: TaxExemptionSubject,
  at: Date,
  orderExempt = false,
): Promise<TaxExemptionDecision> {
  const tenant = companyId.trim();
  if (tenant === "") {
    throw new MoneyError("validation", "Company is required.");
  }
  const hasSubject = subject.exemptionKey !== null || subject.customerRef !== null;
  const records = hasSubject ? await storage.findMatching(tenant, subject, at) : [];
  return decideTaxExemption(records, subject, at, orderExempt);
}

/** In-memory TaxExemptionStorage for tests and local runs. */
export function createMemoryTaxExemptionStorage(): TaxExemptionStorage & { readonly records: ReadonlyMap<string, TaxExemptionRecord> } {
  const records = new Map<string, TaxExemptionRecord>();
  const scoped = (companyId: string, id: string): string => `${companyId}\u0000${id}`;
  return {
    records,
    async findMatching(companyId, subject, at) {
      return [...records.values()].filter((record) => record.companyId === companyId && exemptionApplies(record, subject, at));
    },
    async insert(record) {
      const key = scoped(record.companyId, record.id);
      if (records.has(key)) return false;
      records.set(key, record);
      return true;
    },
    async deactivate(companyId, id) {
      const record = records.get(scoped(companyId, id));
      if (!record || record.companyId !== companyId) return false;
      records.set(scoped(companyId, id), { ...record, active: false });
      return true;
    },
  };
}
