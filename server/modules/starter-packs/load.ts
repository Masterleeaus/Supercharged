// Loads a starter pack into a company and runs an enquiry through the enquiry-to-quote flow (#362).
// Pure: no database, no network, no clock reads. The caller stores the returned config.
//
// Rules:
//   - A pack loads only into an empty company (no pack, services or templates yet).
//   - Loading is never silent about what changed: each change is listed.
//   - Per-company overrides are merged by id and the result is validated again.
//   - The enquiry flow never prices a job. It returns a draft marked pending_staff_pricing.
//   - The enquiry flow never sends. The acknowledgement is returned as a preview for the gate.

import { validatePack, type MessageTemplate, type Pack, type QuoteField, type Service } from './pack.schema.ts';

export interface CompanyConfig {
  companyId: string;
  companyName: string;
  timezone: string | null;
  /** The pack loaded into this company, or null when none is loaded. */
  packId: string | null;
  agentRoles: string[];
  leadQuestions: Pack['leadQuestions'];
  quoteFields: QuoteField[];
  services: Service[];
  messageTemplates: MessageTemplate[];
  connectorPresets: Pack['connectorPresets'];
  complianceText: string[];
}

export function emptyCompany(companyId: string, companyName: string): CompanyConfig {
  return {
    companyId,
    companyName,
    timezone: null,
    packId: null,
    agentRoles: [],
    leadQuestions: [],
    quoteFields: [],
    services: [],
    messageTemplates: [],
    connectorPresets: [],
    complianceText: [],
  };
}

export interface PackOverrides {
  services?: Array<Partial<Service> & { id: string }>;
  messageTemplates?: Array<Partial<MessageTemplate> & { id: string }>;
}

export type LoadResult =
  | { ok: true; config: CompanyConfig; changes: string[] }
  | { ok: false; errors: string[] };

function mergeById<T extends { id: string }>(base: T[], overrides: Array<Partial<T> & { id: string }> | undefined, label: string, changes: string[]): { items: T[]; errors: string[] } {
  const errors: string[] = [];
  const items = base.map((b) => ({ ...b }));
  for (const o of overrides ?? []) {
    const idx = items.findIndex((i) => i.id === o.id);
    if (idx === -1) {
      errors.push(`override names an unknown ${label} ${o.id}`);
      continue;
    }
    items[idx] = { ...items[idx], ...o } as T;
    changes.push(`${label} ${o.id} changed for this company`);
  }
  return { items, errors };
}

export function loadPack(input: { pack: unknown; company: CompanyConfig; overrides?: PackOverrides }): LoadResult {
  const { company } = input;
  if (company.packId !== null) return { ok: false, errors: [`company already has pack ${company.packId}`] };
  if (company.services.length || company.messageTemplates.length || company.agentRoles.length) {
    return { ok: false, errors: ['company is not empty; a pack loads only into an empty company'] };
  }

  const checked = validatePack(input.pack);
  if (checked.ok === false) return { ok: false, errors: checked.errors };
  const pack = checked.pack;

  const changes: string[] = [];
  const services = mergeById(pack.services, input.overrides?.services, 'service', changes);
  const templates = mergeById(pack.messageTemplates, input.overrides?.messageTemplates, 'template', changes);
  const errors = [...services.errors, ...templates.errors];

  const merged: Pack = { ...pack, services: services.items, messageTemplates: templates.items };
  const recheck = validatePack(merged);
  if (recheck.ok === false) errors.push(...recheck.errors);
  if (errors.length > 0) return { ok: false, errors };

  const config: CompanyConfig = {
    ...company,
    packId: `${pack.id}@${pack.version}`,
    agentRoles: [...pack.agentRoles],
    leadQuestions: pack.leadQuestions.map((q) => ({ ...q })),
    quoteFields: pack.quoteFields.map((f) => ({ ...f })),
    services: merged.services,
    messageTemplates: merged.messageTemplates,
    connectorPresets: pack.connectorPresets.map((c) => ({ ...c })),
    complianceText: [...pack.compliance.text],
  };
  changes.unshift(
    `loaded ${pack.name} (${pack.id}@${pack.version})`,
    `${config.agentRoles.length} agent roles`,
    `${config.leadQuestions.length} lead questions`,
    `${config.quoteFields.length} quote fields`,
    `${config.services.length} services`,
    `${config.messageTemplates.length} message templates`,
    `${config.connectorPresets.length} connector suggestions`,
  );
  return { ok: true, config, changes };
}

export interface Enquiry {
  serviceId: string;
  /** Answers keyed by quote field key. */
  answers: Record<string, string | number | boolean | null | undefined>;
  clientName: string;
}

export type EnquiryResult =
  | { status: 'needs_info'; missing: Array<{ questionId: string | null; field: string; prompt: string | null }> }
  | { status: 'unknown_service' }
  | {
      status: 'ready';
      draft: {
        serviceId: string;
        serviceName: string;
        pricingUnit: Service['pricingUnit'];
        fields: Record<string, string | number | boolean>;
        price: null;
        state: 'pending_staff_pricing';
      };
      acknowledgement: { channel: MessageTemplate['channel']; subject: string | null; body: string } | null;
      /** Always false here. Sending goes through the pre-send gate, never from this function. */
      sent: false;
    };

function isAnswered(v: unknown): v is string | number | boolean {
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
}

function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new RangeError(`missing ${name}`);
    return value;
  });
}

export function runEnquiry(config: CompanyConfig, enquiry: Enquiry): EnquiryResult {
  const service = config.services.find((s) => s.id === enquiry.serviceId);
  if (!service) return { status: 'unknown_service' };

  // Each service needs its own quote fields. Required ones must be answered. Required lead questions too.
  const requiredFields = new Set(
    config.quoteFields.filter((f) => f.required).map((f) => f.key),
  );
  const serviceFields = service.quoteFieldKeys.filter((k) => requiredFields.has(k));
  const gaps: Array<{ questionId: string | null; field: string; prompt: string | null }> = [];
  for (const field of new Set([...serviceFields, ...config.leadQuestions.filter((q) => q.required).map((q) => q.field)])) {
    if (!isAnswered(enquiry.answers[field])) {
      const q = config.leadQuestions.find((x) => x.field === field) ?? null;
      gaps.push({ questionId: q?.id ?? null, field, prompt: q?.prompt ?? null });
    }
  }
  if (gaps.length > 0) return { status: 'needs_info', missing: gaps };

  const fields: Record<string, string | number | boolean> = {};
  for (const key of service.quoteFieldKeys) {
    const v = enquiry.answers[key];
    if (isAnswered(v)) fields[key] = v;
  }

  const template = config.messageTemplates.find((t) => t.purpose === 'enquiry_ack') ?? null;
  let acknowledgement: { channel: MessageTemplate['channel']; subject: string | null; body: string } | null = null;
  if (template) {
    acknowledgement = {
      channel: template.channel,
      subject: template.subject === null ? null : fillTemplate(template.subject, vars(config, enquiry, service)),
      body: fillTemplate(template.body, vars(config, enquiry, service)),
    };
  }

  return {
    status: 'ready',
    draft: {
      serviceId: service.id,
      serviceName: service.name,
      pricingUnit: service.pricingUnit,
      fields,
      price: null,
      state: 'pending_staff_pricing',
    },
    acknowledgement,
    sent: false,
  };
}

function vars(config: CompanyConfig, enquiry: Enquiry, service: Service): Record<string, string> {
  return {
    companyName: config.companyName,
    clientName: enquiry.clientName,
    serviceName: service.name,
    quoteSummary: service.name,
    visitTime: '',
    reviewUrl: '',
    bookingUrl: '',
    paymentUrl: '',
  };
}
