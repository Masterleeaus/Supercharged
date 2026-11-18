/**
 * Accounting connectors (#356): Xero, MYOB AccountRight and QuickBooks Online. Each one pushes a
 * finished invoice and reads its payment status back.
 *
 * Scope: invoices only. No action here moves money, and no tax is calculated: the tax type and
 * currency come from the caller, which takes them from the company's own settings.
 *
 * Tenant ids (Xero tenant, MYOB company file id, QBO realm id) are passed per call in `input`.
 * Registry implementations are shared across companies, so a per-company id cannot live in the
 * factory options.
 *
 * Written against the documented APIs but not yet checked against live sandboxes. The open
 * questions are listed in the PR body (version headers, field names, idempotency behaviour).
 */
import { ConnectorError, type ActionRequest, type ConnectorCredentials, type ConnectorDefinition } from '../sdk/contract.ts';
import { bearerToken, callVendor, readJson, requireString, type FetchLike } from './vendor-http.ts';

export const XERO_API_URL = 'https://api.xero.com/api.xro/2.0/';
export const MYOB_API_URL = 'https://api.myob.com/accountright/';
export const QBO_API_URL = 'https://quickbooks.api.intuit.com/v3/company/';
export const QBO_MINOR_VERSION = '65';

const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_LINES = 200;

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode?: string;
  itemId?: string;
  taxType?: string;
}

export interface InvoiceInput {
  reference: string;
  customerId: string;
  date: string;
  dueDate?: string;
  currency: string;
  lines: InvoiceLine[];
}

export interface PaymentStatus {
  paid: boolean;
  amountDue: number;
}

export interface AccountingOptions {
  fetch: FetchLike;
  /** MYOB requires its client id in an x-myobapi-key header. It is an app-level value, not per company. */
  myobApiKey?: string;
}

function field(input: unknown, name: string): unknown {
  return input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[name] : undefined;
}

function money(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ConnectorError('validation', `${name} must be a non-negative number`);
  // Tolerate float noise (19.99 * 100 is not exactly 1999) but refuse values that would be rounded silently.
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw new ConnectorError('validation', `${name} must have at most 2 decimal places`);
  return value;
}

function quantityOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new ConnectorError('validation', 'quantity must be a number above zero');
  }
  return value;
}

function parseInvoice(input: unknown, lineRule: 'account' | 'item'): InvoiceInput {
  const reference = requireString(input, 'reference');
  if (!REFERENCE_PATTERN.test(reference)) throw new ConnectorError('validation', 'reference must be letters, digits, dash or underscore');
  const currency = requireString(input, 'currency');
  if (!CURRENCY_PATTERN.test(currency)) throw new ConnectorError('validation', 'currency must be a 3 letter code');
  const rawLines = field(input, 'lines');
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_LINES) {
    throw new ConnectorError('validation', `lines must be 1 to ${MAX_LINES} items`);
  }
  const lines = rawLines.map((line): InvoiceLine => {
    const quantity = quantityOf(field(line, 'quantity'));
    const out: InvoiceLine = {
      description: requireString(line, 'description'),
      quantity,
      unitAmount: money(field(line, 'unitAmount'), 'unitAmount'),
    };
    const taxType = field(line, 'taxType');
    if (typeof taxType === 'string' && taxType.length > 0) out.taxType = taxType;
    if (lineRule === 'account') out.accountCode = requireString(line, 'accountCode');
    else out.itemId = requireString(line, 'itemId');
    return out;
  });
  const dueDate = field(input, 'dueDate');
  return {
    reference,
    customerId: requireString(input, 'customerId'),
    date: requireString(input, 'date'),
    dueDate: typeof dueDate === 'string' && dueDate.length > 0 ? dueDate : undefined,
    currency,
    lines,
  };
}

function idOf(input: unknown, name: string): string {
  const id = requireString(input, name);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new ConnectorError('validation', `${name} has invalid characters`);
  return id;
}

/** Turns the vendor's own status fields into paid or not paid. Anything unclear counts as not paid. */
function xeroStatus(invoice: Record<string, unknown>): PaymentStatus {
  const amountDue = typeof invoice.AmountDue === 'number' ? invoice.AmountDue : NaN;
  if (!Number.isFinite(amountDue)) throw new ConnectorError('unknown', 'Vendor did not return an amount due');
  return { paid: invoice.Status === 'PAID', amountDue };
}

export function createXeroConnector(opts: AccountingOptions): ConnectorDefinition {
  const headersFor = (credentials: ConnectorCredentials, tenantId: string) => ({
    authorization: `Bearer ${bearerToken(credentials as { type: string; accessToken?: string })}`,
    accept: 'application/json',
    'xero-tenant-id': tenantId,
  });
  return {
    id: 'xero',
    auth: 'oauth2',
    capabilities: ['read', 'write'],
    entities: ['invoice'],
    actions: {
      createInvoice: { kind: 'write', entity: 'invoice' },
      getInvoicePaymentStatus: { kind: 'read', entity: 'invoice' },
    },
    async execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
      const { action, input, timeoutMs, idempotencyKey } = request;
      const tenantId = idOf(input, 'tenantId');
      if (action === 'createInvoice') {
        const inv = parseInvoice(input, 'account');
        const body = {
          Invoices: [
            {
              Type: 'ACCREC',
              Reference: inv.reference,
              Contact: { ContactID: inv.customerId },
              Date: inv.date,
              DueDate: inv.dueDate,
              CurrencyCode: inv.currency,
              LineItems: inv.lines.map((l) => ({
                Description: l.description,
                Quantity: l.quantity,
                UnitAmount: l.unitAmount,
                AccountCode: l.accountCode,
                TaxType: l.taxType,
              })),
            },
          ],
        };
        const headers: Record<string, string> = { ...headersFor(credentials, tenantId), 'content-type': 'application/json' };
        if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
        const response = await callVendor(opts.fetch, `${XERO_API_URL}Invoices`, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
        const created = (await readJson(response)) as { Invoices?: Array<{ InvoiceID?: string }> };
        const id = created.Invoices?.[0]?.InvoiceID;
        if (!id) throw new ConnectorError('unknown', 'Vendor did not return the invoice id');
        return { vendorInvoiceId: id };
      }
      if (action === 'getInvoicePaymentStatus') {
        const id = idOf(input, 'vendorInvoiceId');
        const response = await callVendor(opts.fetch, `${XERO_API_URL}Invoices/${encodeURIComponent(id)}`, { method: 'GET', headers: headersFor(credentials, tenantId) }, timeoutMs);
        const body = (await readJson(response)) as { Invoices?: Array<Record<string, unknown>> };
        const invoice = body.Invoices?.[0];
        if (!invoice) throw new ConnectorError('not_found', 'Vendor invoice not found');
        return xeroStatus(invoice);
      }
      throw new ConnectorError('validation', `unknown action "${action}"`);
    },
  };
}

export function createMyobConnector(opts: AccountingOptions): ConnectorDefinition {
  const base = (cfId: string) => `${MYOB_API_URL}${encodeURIComponent(cfId)}/`;
  const headersFor = (credentials: ConnectorCredentials, json: boolean) => {
    const h: Record<string, string> = {
      authorization: `Bearer ${bearerToken(credentials as { type: string; accessToken?: string })}`,
      accept: 'application/json',
      'x-myobapi-version': 'v2',
    };
    if (opts.myobApiKey) h['x-myobapi-key'] = opts.myobApiKey;
    if (json) h['content-type'] = 'application/json';
    return h;
  };
  return {
    id: 'myob',
    auth: 'oauth2',
    capabilities: ['read', 'write'],
    entities: ['invoice'],
    actions: {
      createInvoice: { kind: 'write', entity: 'invoice' },
      getInvoicePaymentStatus: { kind: 'read', entity: 'invoice' },
    },
    async execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
      const { action, input, timeoutMs } = request;
      const cfId = idOf(input, 'companyFileId');
      if (action === 'createInvoice') {
        const inv = parseInvoice(input, 'account');
        // MYOB has no idempotency header. Look for this reference first so a retried write does not create a second invoice.
        const found = await callVendor(
          opts.fetch,
          `${base(cfId)}Sale/Invoice/Item?$filter=${encodeURIComponent(`Comment eq '${inv.reference}'`)}`,
          { method: 'GET', headers: headersFor(credentials, false) },
          timeoutMs,
        );
        const existing = (await readJson(found)) as { Items?: Array<{ UID?: string }> };
        if (existing.Items?.[0]?.UID) return { vendorInvoiceId: existing.Items[0].UID, reused: true };
        const body = {
          Customer: { UID: inv.customerId },
          Date: inv.date,
          Comment: inv.reference,
          Lines: inv.lines.map((l) => ({
            Description: l.description,
            ShipQuantity: l.quantity,
            UnitPrice: l.unitAmount,
            Account: { DisplayID: l.accountCode },
            TaxCode: l.taxType ? { Code: l.taxType } : undefined,
          })),
        };
        const response = await callVendor(opts.fetch, `${base(cfId)}Sale/Invoice/Item`, { method: 'POST', headers: headersFor(credentials, true), body: JSON.stringify(body) }, timeoutMs);
        const location = response.headers.get('location');
        const uid = location?.split('/').filter(Boolean).pop();
        if (!uid) throw new ConnectorError('unknown', 'Vendor did not return the invoice id');
        return { vendorInvoiceId: uid };
      }
      if (action === 'getInvoicePaymentStatus') {
        const id = idOf(input, 'vendorInvoiceId');
        const response = await callVendor(opts.fetch, `${base(cfId)}Sale/Invoice/Item/${encodeURIComponent(id)}`, { method: 'GET', headers: headersFor(credentials, false) }, timeoutMs);
        const invoice = (await readJson(response)) as { BalanceDueAmount?: number };
        const due = typeof invoice.BalanceDueAmount === 'number' ? invoice.BalanceDueAmount : NaN;
        if (!Number.isFinite(due)) throw new ConnectorError('unknown', 'Vendor did not return a balance');
        return { paid: due === 0, amountDue: due };
      }
      throw new ConnectorError('validation', `unknown action "${action}"`);
    },
  };
}

export function createQuickBooksConnector(opts: AccountingOptions): ConnectorDefinition {
  const url = (realmId: string, path: string, extra = '') =>
    `${QBO_API_URL}${encodeURIComponent(realmId)}/${path}?minorversion=${QBO_MINOR_VERSION}${extra}`;
  const headersFor = (credentials: ConnectorCredentials, json: boolean) => {
    const h: Record<string, string> = { authorization: `Bearer ${bearerToken(credentials as { type: string; accessToken?: string })}`, accept: 'application/json' };
    if (json) h['content-type'] = 'application/json';
    return h;
  };
  return {
    id: 'quickbooks',
    auth: 'oauth2',
    capabilities: ['read', 'write'],
    entities: ['invoice'],
    actions: {
      createInvoice: { kind: 'write', entity: 'invoice' },
      getInvoicePaymentStatus: { kind: 'read', entity: 'invoice' },
    },
    async execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
      const { action, input, timeoutMs, idempotencyKey } = request;
      const realmId = idOf(input, 'realmId');
      if (action === 'createInvoice') {
        const inv = parseInvoice(input, 'item');
        const body = {
          CustomerRef: { value: inv.customerId },
          TxnDate: inv.date,
          DueDate: inv.dueDate,
          CurrencyRef: { value: inv.currency },
          PrivateNote: inv.reference,
          Line: inv.lines.map((l) => ({
            Amount: Math.round(l.quantity * l.unitAmount * 100) / 100,
            DetailType: 'SalesItemLineDetail',
            Description: l.description,
            SalesItemLineDetail: {
              ItemRef: { value: l.itemId },
              Qty: l.quantity,
              UnitPrice: l.unitAmount,
              TaxCodeRef: l.taxType ? { value: l.taxType } : undefined,
            },
          })),
        };
        const extra = idempotencyKey ? `&requestid=${encodeURIComponent(idempotencyKey)}` : '';
        const response = await callVendor(opts.fetch, url(realmId, 'invoice', extra), { method: 'POST', headers: headersFor(credentials, true), body: JSON.stringify(body) }, timeoutMs);
        const created = (await readJson(response)) as { Invoice?: { Id?: string } };
        const id = created.Invoice?.Id;
        if (!id) throw new ConnectorError('unknown', 'Vendor did not return the invoice id');
        return { vendorInvoiceId: id };
      }
      if (action === 'getInvoicePaymentStatus') {
        const id = idOf(input, 'vendorInvoiceId');
        const response = await callVendor(opts.fetch, url(realmId, `invoice/${encodeURIComponent(id)}`), { method: 'GET', headers: headersFor(credentials, false) }, timeoutMs);
        const body = (await readJson(response)) as { Invoice?: { Balance?: number } };
        const due = body.Invoice?.Balance;
        if (typeof due !== 'number') throw new ConnectorError('unknown', 'Vendor did not return a balance');
        return { paid: due === 0, amountDue: due };
      }
      throw new ConnectorError('validation', `unknown action "${action}"`);
    },
  };
}
