export const COMPANY_ID_FIELD = 'company_id';
export const LEGACY_COMPANY_FIELDS = Object.freeze([
  'tenant_id','tenant_company_id','tenant','tenantCompanyId','tenant_company','workspace_tenant_id'
]);

export function assertAuthorityCompanyId(value) {
  const company_id = String(value ?? '').trim();
  if (!company_id) throw new Error('company_id-required');
  return company_id;
}

export function rejectLegacyAuthorityBoundaryDeep(input, path = 'payload', seen = new WeakSet()) {
  if (!input || typeof input !== 'object') return;
  if (seen.has(input)) return;
  seen.add(input);
  if (Array.isArray(input)) {
    input.forEach((value, index) => rejectLegacyAuthorityBoundaryDeep(value, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    if (LEGACY_COMPANY_FIELDS.includes(key)) throw new Error(`legacy-company-boundary:${path}.${key}`);
    if (value && typeof value === 'object') rejectLegacyAuthorityBoundaryDeep(value, `${path}.${key}`, seen);
  }
}
