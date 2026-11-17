/**
 * Reconciliation report for pushed invoices (#356): which invoices pushed to the accounting tool
 * are paid, unpaid, missing on the vendor side, or duplicated locally.
 *
 * Pure. The caller supplies the pushed list and the vendor statuses it read back.
 */
export interface PushedInvoice {
  invoiceId: string;
  vendorInvoiceId: string;
}

export interface VendorStatusRow {
  paid: boolean;
  amountDue: number;
}

export type ReconcileRowStatus = 'paid' | 'unpaid' | 'not_found' | 'duplicate';

export interface ReconcileRow {
  invoiceId: string;
  vendorInvoiceId: string;
  status: ReconcileRowStatus;
  amountDue?: number;
}

export interface ReconcileReport {
  rows: ReconcileRow[];
  totals: { pushed: number; paid: number; unpaid: number; notFound: number; duplicate: number };
}

export function reconcile(pushed: PushedInvoice[], vendorStatus: Map<string, VendorStatusRow>): ReconcileReport {
  const seen = new Map<string, number>();
  for (const p of pushed) seen.set(p.invoiceId, (seen.get(p.invoiceId) ?? 0) + 1);

  const rows: ReconcileRow[] = pushed.map((p) => {
    if ((seen.get(p.invoiceId) ?? 0) > 1) return { invoiceId: p.invoiceId, vendorInvoiceId: p.vendorInvoiceId, status: 'duplicate' };
    const st = vendorStatus.get(p.vendorInvoiceId);
    if (!st) return { invoiceId: p.invoiceId, vendorInvoiceId: p.vendorInvoiceId, status: 'not_found' };
    return { invoiceId: p.invoiceId, vendorInvoiceId: p.vendorInvoiceId, status: st.paid ? 'paid' : 'unpaid', amountDue: st.amountDue };
  });

  const count = (s: ReconcileRowStatus) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    totals: { pushed: rows.length, paid: count('paid'), unpaid: count('unpaid'), notFound: count('not_found'), duplicate: count('duplicate') },
  };
}
