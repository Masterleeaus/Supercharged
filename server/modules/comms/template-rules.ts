// Approved-template rendering for customer-facing messages.
// Pure functions, no state, no database. Values are inserted as plain text;
// nothing is HTML-escaped or otherwise transformed beyond placeholder substitution.

export const MAX_BODY_LENGTH = 1600;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VARIABLE_PATTERN = /^[a-z_]+$/;
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

export interface TemplateDefinition {
  id: string;
  channel: string;
  body: string;
  variables: readonly string[];
  approved: boolean;
  allowLinks?: boolean;
  allowContact?: boolean;
}

export interface Template {
  readonly id: string;
  readonly channel: string;
  readonly body: string;
  readonly variables: readonly string[];
  readonly approved: boolean;
  readonly allowLinks: boolean;
  readonly allowContact: boolean;
}

export type RenderRefusalReason =
  | 'template_not_approved'
  | 'template_not_defined'
  | 'missing_variable'
  | 'unknown_variable'
  | 'invalid_value'
  | 'link_not_allowed'
  | 'contact_not_allowed';

export type RenderResult =
  | { ok: true; text: string }
  | { ok: false; reason: RenderRefusalReason; names: string[] };

export class TemplateDefinitionError extends Error {
  readonly names: string[];
  constructor(message: string, names: string[] = []) {
    super(message);
    this.name = 'TemplateDefinitionError';
    this.names = names;
  }
}

// Only templates produced by defineTemplate are renderable, so a hand-built
// object cannot pass as an approved template.
const defined = new WeakSet<object>();

const URL_PATTERNS: RegExp[] = [
  /\b(?:https?:\/\/|www\.)\S+/i,
  /(?<![@\w.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|au|info|biz|app|dev|me|site|xyz|ly)\b(?:\/\S*)?/i,
];
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_CANDIDATE = /\+?\d[\d\s().-]*\d/g;
const PHONE_MIN_DIGITS = 9;

function containsUrl(value: string): boolean {
  return URL_PATTERNS.some((pattern) => pattern.test(value));
}

function containsEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

function containsPhone(value: string): boolean {
  for (const match of value.matchAll(PHONE_CANDIDATE)) {
    const digits = match[0].replace(/\D/g, '').length;
    if (digits >= PHONE_MIN_DIGITS) return true;
  }
  return false;
}

function uniqueSorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

export function defineTemplate(input: TemplateDefinition): Template {
  if (typeof input !== 'object' || input === null) {
    throw new TemplateDefinitionError('template definition must be an object');
  }
  const { id, channel, body, variables, approved, allowLinks = false, allowContact = false } = input;

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TemplateDefinitionError(`template id must be lowercase kebab-case: ${String(id)}`);
  }
  if (typeof channel !== 'string' || channel.trim() === '') {
    throw new TemplateDefinitionError('template channel must be a non-empty string');
  }
  if (typeof body !== 'string' || body.trim() === '') {
    throw new TemplateDefinitionError('template body must be non-empty');
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new TemplateDefinitionError(`template body must be at most ${MAX_BODY_LENGTH} characters`);
  }
  if (!Array.isArray(variables)) {
    throw new TemplateDefinitionError('template variables must be a list');
  }
  if (typeof approved !== 'boolean') {
    throw new TemplateDefinitionError('template approved must be a boolean');
  }

  const badNames = variables.filter((name) => typeof name !== 'string' || !VARIABLE_PATTERN.test(name));
  if (badNames.length > 0) {
    throw new TemplateDefinitionError(
      'variable names must match /^[a-z_]+$/',
      badNames.map(String),
    );
  }
  const duplicates = variables.filter((name, index) => variables.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new TemplateDefinitionError('variable names must be unique', uniqueSorted(duplicates));
  }

  const used = [...body.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  const declared = new Set(variables);
  const undeclared = used.filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new TemplateDefinitionError(
      'body uses variables that are not declared',
      uniqueSorted(undeclared),
    );
  }
  const usedSet = new Set(used);
  const unused = variables.filter((name) => !usedSet.has(name));
  if (unused.length > 0) {
    throw new TemplateDefinitionError('declared variables are not used in body', uniqueSorted(unused));
  }

  const template: Template = Object.freeze({
    id,
    channel,
    body,
    variables: Object.freeze([...variables]),
    approved,
    allowLinks: allowLinks === true,
    allowContact: allowContact === true,
  });
  defined.add(template);
  return template;
}

export function renderTemplate(
  template: Template,
  values: Record<string, unknown>,
  options: { company: string },
): RenderResult {
  if (typeof options !== 'object' || options === null || typeof options.company !== 'string' || options.company.trim() === '') {
    throw new TypeError('renderTemplate requires options.company');
  }
  if (typeof template !== 'object' || template === null || !defined.has(template)) {
    return { ok: false, reason: 'template_not_defined', names: [] };
  }
  if (template.approved !== true) {
    return { ok: false, reason: 'template_not_approved', names: [] };
  }

  const provided = values ?? {};
  const declared = new Set(template.variables);

  const missing = template.variables.filter((name) => !Object.prototype.hasOwnProperty.call(provided, name));
  if (missing.length > 0) {
    return { ok: false, reason: 'missing_variable', names: uniqueSorted(missing) };
  }

  const unknown = Object.keys(provided).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    return { ok: false, reason: 'unknown_variable', names: uniqueSorted(unknown) };
  }

  const invalid = template.variables.filter((name) => typeof provided[name] !== 'string');
  if (invalid.length > 0) {
    return { ok: false, reason: 'invalid_value', names: uniqueSorted(invalid) };
  }
  const strings = provided as Record<string, string>;

  if (!template.allowLinks) {
    const links = template.variables.filter((name) => containsUrl(strings[name]));
    if (links.length > 0) {
      return { ok: false, reason: 'link_not_allowed', names: uniqueSorted(links) };
    }
  }

  if (!template.allowContact) {
    const contacts = template.variables.filter(
      (name) => containsEmail(strings[name]) || containsPhone(strings[name]),
    );
    if (contacts.length > 0) {
      return { ok: false, reason: 'contact_not_allowed', names: uniqueSorted(contacts) };
    }
  }

  // Single pass with a replacer function: values are never re-scanned for placeholders
  // and '$' sequences in values are not interpreted as replacement patterns.
  const text = template.body.replace(PLACEHOLDER_PATTERN, (_whole, name: string) => strings[name]);
  return { ok: true, text };
}
