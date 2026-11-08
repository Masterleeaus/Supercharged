const LEGACY_COMPANY_KEYS = new Set(["tenant_id", "tenant_company_id", "workspace_tenant_id"]);
const COMPANY_ID = /^[A-Za-z0-9._:-]{2,128}$/;

function rejectLegacyCompanyKeys(value, path = "company_context") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectLegacyCompanyKeys(child, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (LEGACY_COMPANY_KEYS.has(key)) {
      throw new TypeError(`${path}.${key} is a legacy tenant boundary; company_id is canonical`);
    }
    rejectLegacyCompanyKeys(child, `${path}.${key}`);
  }
}

/** Validate an already-resolved context. This does not authenticate membership or grant authority. */
export function normalizeCompanyContext(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("company context must be an object");
  }
  rejectLegacyCompanyKeys(input);
  const company_id = String(input.company_id ?? "").trim();
  if (!COMPANY_ID.test(company_id)) throw new TypeError("a valid company_id is required");
  return Object.freeze({ ...input, company_id });
}
