// Duplicate-contact detection for one company. Pure functions: no store, no network, no merge.
// Email and E.164 rules are copied from campaigns/campaign-service.ts (not imported).

export interface DedupeContact {
  id: string;
  companyId: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
}

export interface PhoneOptions {
  /** Country calling code used to read a national number with a leading 0, e.g. "61" or "+61". */
  defaultCountryCode?: string;
}

export interface DuplicateKey {
  kind: 'email' | 'phone';
  value: string;
}

export interface DuplicateGroup {
  /** Contact ids in the group, in input order. Always at least two. */
  ids: string[];
  /** Normalised keys shared by at least two members of this group. */
  keys: DuplicateKey[];
}

export interface FindDuplicateOptions extends PhoneOptions {
  companyId: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/** Trims and lowercases an email. Returns undefined when the value is not an email shape. */
export function normalizeEmail(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const value = s.trim().toLowerCase();
  if (value.length === 0 || value.length > 320) return undefined;
  return EMAIL.test(value) ? value : undefined;
}

/**
 * Normalises a phone number to E.164. Spaces, dashes and brackets are stripped.
 * A leading "+" is kept. A national number with a leading 0 is accepted only when
 * defaultCountryCode is given. Returns undefined when no valid E.164 form can be derived.
 */
export function normalizePhone(s: unknown, opts: PhoneOptions = {}): string | undefined {
  if (typeof s !== 'string') return undefined;
  const stripped = s.trim().replace(/[\s\-()[\]]/g, '');
  if (stripped.length === 0) return undefined;

  if (stripped.startsWith('+')) {
    return E164.test(stripped) ? stripped : undefined;
  }

  if (!/^\d+$/.test(stripped)) return undefined;

  if (stripped.startsWith('0')) {
    const cc = (opts.defaultCountryCode ?? '').trim().replace(/^\+/, '');
    if (!/^[1-9]\d{0,3}$/.test(cc)) return undefined;
    const candidate = `+${cc}${stripped.slice(1)}`;
    return E164.test(candidate) ? candidate : undefined;
  }

  return undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Groups contacts from one company that share a normalised email or phone.
 * Grouping is transitive: A sharing an email with B and B sharing a phone with C puts A, B and C
 * in one group. Contacts from other companies are never compared.
 * Throws a TypeError('invalid_company') when options.companyId is not a UUID. An empty list
 * would read as "no duplicates", so the function refuses instead.
 */
export function findDuplicateGroups(
  contacts: ReadonlyArray<DedupeContact>,
  options: FindDuplicateOptions,
): DuplicateGroup[] {
  if (typeof options?.companyId !== 'string' || !UUID.test(options.companyId)) {
    throw new TypeError('invalid_company');
  }
  const phoneOpts: PhoneOptions = { defaultCountryCode: options.defaultCountryCode };
  const scoped = contacts.filter((c) => c.companyId === options.companyId);

  const parent = scoped.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Index each normalised key to the contacts that carry it.
  const keyOwners = new Map<string, number[]>();
  scoped.forEach((c, i) => {
    const email = normalizeEmail(c.email);
    const phone = normalizePhone(c.phone, phoneOpts);
    const keys: string[] = [];
    if (email !== undefined) keys.push(`email:${email}`);
    if (phone !== undefined) keys.push(`phone:${phone}`);
    for (const key of keys) {
      const owners = keyOwners.get(key);
      if (owners) owners.push(i);
      else keyOwners.set(key, [i]);
    }
  });

  for (const owners of keyOwners.values()) {
    for (let j = 1; j < owners.length; j++) union(owners[0], owners[j]);
  }

  const byRoot = new Map<number, number[]>();
  scoped.forEach((_, i) => {
    const root = find(i);
    const members = byRoot.get(root);
    if (members) members.push(i);
    else byRoot.set(root, [i]);
  });

  const groups: DuplicateGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const memberSet = new Set(members);
    const keys: DuplicateKey[] = [];
    for (const [key, owners] of keyOwners) {
      if (owners.length < 2 || !owners.some((o) => memberSet.has(o))) continue;
      const sep = key.indexOf(':');
      keys.push({ kind: key.slice(0, sep) as 'email' | 'phone', value: key.slice(sep + 1) });
    }
    groups.push({ ids: members.map((i) => scoped[i].id), keys });
  }
  return groups;
}
