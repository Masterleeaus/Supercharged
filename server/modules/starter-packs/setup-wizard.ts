// Setup wizard (#363): takes a new business from sign-up to one successful test enquiry, in under
// 30 minutes, without engineering help.
//
// The wizard is a state object plus pure step functions. Nothing goes live until the preview the
// business saw is confirmed by its hash. Every decision is logged with who made it and when.
//
// Steps, in order:
//   tools      which tools the business already uses (mapped to connector suggestions)
//   pack       which starter pack to load
//   connect    connect each required connector (through an injected port)
//   fieldMap   preview how the business's own field names map to the pack's quote fields
//   test       one test enquiry through the pack's flow. Nothing is sent to a client.
//   review     a preview of exactly what will go out on go-live
//   live       explicit go-live, by confirming the preview hash
//
// Pure apart from the injected connector port. The clock is passed in.

import { createHash } from 'node:crypto';
import { validatePack, type Pack } from './pack.schema.ts';
import { runEnquiry, type CompanyConfig } from './load.ts';

export const WIZARD_STEPS = ['tools', 'pack', 'connect', 'fieldMap', 'test', 'review', 'live'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const SETUP_BUDGET_MINUTES = 30;

/** Tool names a business may already use, mapped to the connector they correspond to. */
export const TOOL_TO_CONNECTOR: Record<string, string> = {
  gmail: 'email',
  outlook: 'email',
  'microsoft 365': 'email',
  'google calendar': 'google_calendar',
  jobber: 'jobber',
  servicem8: 'servicem8',
  quickbooks: 'quickbooks',
  xero: 'xero',
  twilio: 'sms',
};

export interface SetupDecision {
  step: WizardStep;
  decision: string;
  actorId: string;
  at: string;
}

export interface SetupState {
  companyId: string;
  startedAt: string;
  completed: WizardStep[];
  tools: Array<{ name: string; connectorId: string | null }>;
  packId: string | null;
  connectors: Record<string, 'connected' | 'failed'>;
  /** Source field name from the business's own tool, mapped to a pack quote field key. */
  fieldMap: Record<string, string> | null;
  testEnquiryPassed: boolean;
  liveAt: string | null;
  log: SetupDecision[];
}

export function startSetup(companyId: string, now: Date): SetupState {
  return {
    companyId,
    startedAt: now.toISOString(),
    completed: [],
    tools: [],
    packId: null,
    connectors: {},
    fieldMap: null,
    testEnquiryPassed: false,
    liveAt: null,
    log: [],
  };
}

function record(state: SetupState, step: WizardStep, decision: string, actorId: string, now: Date): SetupState {
  const log = [...state.log, { step, decision, actorId, at: now.toISOString() }];
  const completed = state.completed.includes(step) ? state.completed : [...state.completed, step];
  return { ...state, log, completed };
}

export function elapsedMinutes(state: SetupState, now: Date): number {
  return (now.getTime() - Date.parse(state.startedAt)) / 60_000;
}

/** Maps the tools a business already uses to connector suggestions. Unknown tools stay 'manual'. */
export function recordTools(state: SetupState, tools: string[], actorId: string, now: Date): SetupState {
  const mapped = tools
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((name) => ({ name, connectorId: TOOL_TO_CONNECTOR[name.toLowerCase()] ?? null }));
  const manual = mapped.filter((t) => t.connectorId === null).map((t) => t.name);
  const next = { ...state, tools: mapped };
  return record(
    next,
    'tools',
    `tools: ${mapped.filter((t) => t.connectorId).length} mapped to connectors${manual.length ? `, ${manual.length} to set up by hand (${manual.join(', ')})` : ''}`,
    actorId,
    now,
  );
}

export function choosePack(state: SetupState, rawPack: unknown, actorId: string, now: Date): { ok: true; state: SetupState; pack: Pack } | { ok: false; errors: string[] } {
  const checked = validatePack(rawPack);
  if (checked.ok === false) return { ok: false, errors: checked.errors };
  const next = { ...state, packId: `${checked.pack.id}@${checked.pack.version}` };
  return { ok: true, state: record(next, 'pack', `pack chosen: ${next.packId}`, actorId, now), pack: checked.pack };
}

/** Connectors the pack asks for that the business's tools cover, plus any the pack requires. */
export function connectorsToConnect(state: SetupState, pack: Pack): Array<{ connectorId: string; required: boolean }> {
  const wanted = new Map<string, boolean>();
  for (const preset of pack.connectorPresets) {
    const covered = state.tools.some((t) => t.connectorId === preset.connectorId);
    if (covered || preset.required) wanted.set(preset.connectorId, preset.required);
  }
  return [...wanted.entries()].map(([connectorId, required]) => ({ connectorId, required }));
}

export interface ConnectorPort {
  connect(companyId: string, connectorId: string): Promise<{ ok: boolean }>;
}

/** Connects each wanted connector. A required connector that fails stops the wizard here. */
export async function connectAll(
  state: SetupState,
  pack: Pack,
  port: ConnectorPort,
  actorId: string,
  now: Date,
): Promise<{ state: SetupState; blocked: string[] }> {
  let next = state;
  const blocked: string[] = [];
  for (const { connectorId, required } of connectorsToConnect(state, pack)) {
    let ok = false;
    try {
      ok = (await port.connect(state.companyId, connectorId)).ok === true;
    } catch {
      ok = false;
    }
    next = { ...next, connectors: { ...next.connectors, [connectorId]: ok ? 'connected' : 'failed' } };
    next = record(next, 'connect', `${connectorId} ${ok ? 'connected' : 'failed'}`, actorId, now);
    if (!ok && required) blocked.push(connectorId);
  }
  return { state: next, blocked };
}

function normaliseName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface FieldMapRow {
  source: string;
  target: string | null;
}

/**
 * Proposes a mapping from the business's own field names to the pack's quote fields, by key or
 * label after normalising case and punctuation. Nothing is confirmed until confirmFieldMap runs.
 */
export function previewFieldMap(sourceFields: string[], pack: Pack): { rows: FieldMapRow[]; missingRequired: string[] } {
  const index = new Map<string, string>();
  for (const f of pack.quoteFields) {
    index.set(normaliseName(f.key), f.key);
    index.set(normaliseName(f.label), f.key);
  }
  const rows = sourceFields.map((source) => ({ source, target: index.get(normaliseName(source)) ?? null }));
  const mapped = new Set(rows.map((r) => r.target).filter((t): t is string => t !== null));
  const missingRequired = pack.quoteFields.filter((f) => f.required && !mapped.has(f.key)).map((f) => f.key);
  return { rows, missingRequired };
}

/** Confirms the mapping. Every required quote field must be covered, and every target must be real. */
export function confirmFieldMap(
  state: SetupState,
  pack: Pack,
  mapping: Record<string, string>,
  actorId: string,
  now: Date,
): { ok: true; state: SetupState } | { ok: false; errors: string[] } {
  const keys = new Set(pack.quoteFields.map((f) => f.key));
  const errors: string[] = [];
  for (const [source, target] of Object.entries(mapping)) {
    if (!keys.has(target)) errors.push(`${source} maps to unknown field ${target}`);
  }
  const covered = new Set(Object.values(mapping));
  for (const f of pack.quoteFields) {
    if (f.required && !covered.has(f.key)) errors.push(`required field ${f.key} is not mapped`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const next = { ...state, fieldMap: { ...mapping } };
  return { ok: true, state: record(next, 'fieldMap', `field map confirmed (${Object.keys(mapping).length} fields)`, actorId, now) };
}

/** One test enquiry through the pack's own flow. Nothing is sent to anyone. */
export function runTestEnquiry(state: SetupState, config: CompanyConfig, pack: Pack, actorId: string, now: Date): SetupState {
  const result = runEnquiry(config, {
    serviceId: pack.fixture.enquiry.serviceId,
    answers: pack.fixture.enquiry.answers,
    clientName: 'Test client',
  });
  const passed = result.status === 'ready';
  const next = { ...state, testEnquiryPassed: passed };
  return record(next, 'test', passed ? 'test enquiry passed (nothing sent)' : `test enquiry failed: ${result.status}`, actorId, now);
}

export interface PreviewItem {
  kind: 'connector' | 'template' | 'quote_field' | 'service' | 'compliance';
  label: string;
}

export interface GoLivePreview {
  items: PreviewItem[];
  /** sha256 of the canonical preview. The business confirms this exact value to go live. */
  hash: string;
}

export function buildPreview(state: SetupState, config: CompanyConfig): GoLivePreview {
  const items: PreviewItem[] = [
    ...Object.entries(state.connectors)
      .filter(([, s]) => s === 'connected')
      .map(([id]): PreviewItem => ({ kind: 'connector', label: `connector ${id}` })),
    ...config.messageTemplates.map((t): PreviewItem => ({ kind: 'template', label: `${t.purpose} via ${t.channel}: ${t.id}` })),
    ...config.services.map((s): PreviewItem => ({ kind: 'service', label: `${s.name} (${s.pricingUnit})` })),
    ...config.quoteFields.map((f): PreviewItem => ({ kind: 'quote_field', label: `${f.label}${f.required ? ' (required)' : ''}` })),
    ...config.complianceText.map((text): PreviewItem => ({ kind: 'compliance', label: text })),
  ];
  const hash = createHash('sha256').update(JSON.stringify({ companyId: state.companyId, packId: state.packId, items })).digest('hex');
  return { items, hash };
}

export type GoLiveResult =
  | { ok: true; state: SetupState; withinBudget: boolean; minutes: number }
  | { ok: false; errors: string[] };

/**
 * Goes live only when every earlier step is done, the test enquiry passed, and the business
 * confirms the preview hash it was shown. A changed preview (for example a connector failing
 * later) refuses the confirmation.
 */
export function goLive(
  state: SetupState,
  pack: Pack,
  config: CompanyConfig,
  input: { confirmHash: string; actorId: string; now: Date },
): GoLiveResult {
  const errors: string[] = [];
  if (!state.packId) errors.push('no pack chosen');
  if (!state.fieldMap) errors.push('field map not confirmed');
  if (!state.testEnquiryPassed) errors.push('test enquiry has not passed');
  for (const { connectorId, required } of connectorsToConnect(state, pack)) {
    if (required && state.connectors[connectorId] !== 'connected') errors.push(`required connector ${connectorId} is not connected`);
  }
  const preview = buildPreview(state, config);
  if (input.confirmHash !== preview.hash) errors.push('confirmation does not match the preview shown');
  if (errors.length > 0) return { ok: false, errors };

  const minutes = elapsedMinutes(state, input.now);
  const next = record({ ...state, liveAt: input.now.toISOString() }, 'live', `went live (${minutes.toFixed(1)} minutes)`, input.actorId, input.now);
  return { ok: true, state: next, withinBudget: minutes <= SETUP_BUDGET_MINUTES, minutes };
}
