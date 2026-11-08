const LEGACY_TENANT_KEYS = new Set(['tenant_id', 'tenant_company_id', 'tenantId', 'tenantCompanyId']);

export const FEED_SEVERITY = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  INFO: 'INFO',
  NORMAL: 'NORMAL',
  IMPORTANT: 'IMPORTANT',
  URGENT: 'URGENT',
  CRITICAL: 'CRITICAL'
});

export const FEED_SEVERITY_PROFILE = Object.freeze({
  UNKNOWN: Object.freeze({ rank: 0, attention: 'none', presentation: 'neutral', interrupt: false }),
  INFO: Object.freeze({ rank: 1, attention: 'awareness', presentation: 'green', interrupt: false }),
  NORMAL: Object.freeze({ rank: 2, attention: 'routine', presentation: 'green', interrupt: false }),
  IMPORTANT: Object.freeze({ rank: 3, attention: 'review', presentation: 'orange', interrupt: false }),
  URGENT: Object.freeze({ rank: 4, attention: 'deal_with_it', presentation: 'red', interrupt: true }),
  CRITICAL: Object.freeze({ rank: 5, attention: 'immediate', presentation: 'red', interrupt: true })
});

const ALIASES = Object.freeze({
  '': 'UNKNOWN', UNKNOWN: 'UNKNOWN', NONE: 'INFO', INFO: 'INFO', INFORMATIONAL: 'INFO', LOW: 'INFO',
  NORMAL: 'NORMAL', ROUTINE: 'NORMAL', MEDIUM: 'IMPORTANT', MODERATE: 'IMPORTANT', IMPORTANT: 'IMPORTANT',
  HIGH: 'URGENT', URGENT: 'URGENT', IMMEDIATE: 'CRITICAL', CRITICAL: 'CRITICAL', EMERGENCY: 'CRITICAL'
});

function rejectLegacyTenantFields(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((item, index) => rejectLegacyTenantFields(item, `${path}[${index}]`));
  for (const [key, child] of Object.entries(value)) {
    if (LEGACY_TENANT_KEYS.has(key)) throw new Error(`legacy-tenant-authority-field:${path}.${key}`);
    rejectLegacyTenantFields(child, `${path}.${key}`);
  }
}

export function normalizeFeedSeverity(value, { fallback = FEED_SEVERITY.UNKNOWN } = {}) {
  let raw = value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    rejectLegacyTenantFields(raw);
    for (const key of ['severity', 'urgency', 'level', 'priority', 'risk']) {
      if (raw[key] != null) { raw = raw[key]; break; }
    }
  }
  const key = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ALIASES[key] || fallback;
}

export function feedSeverityProfile(value) {
  const severity = normalizeFeedSeverity(value);
  return Object.freeze({ severity, ...FEED_SEVERITY_PROFILE[severity] });
}

export function workforceUrgencyForSeverity(value) {
  const severity = normalizeFeedSeverity(value, { fallback: FEED_SEVERITY.NORMAL });
  if (severity === FEED_SEVERITY.CRITICAL) return 'CRITICAL';
  if (severity === FEED_SEVERITY.URGENT || severity === FEED_SEVERITY.IMPORTANT) return 'HIGH';
  if (severity === FEED_SEVERITY.INFO || severity === FEED_SEVERITY.UNKNOWN) return 'INFO';
  return 'NORMAL';
}

export function buildFeedSeverityEnvelope(value) {
  const profile = feedSeverityProfile(value);
  return Object.freeze({
    schema: 'titan.feed.severity.v1',
    ...profile,
    authority_granted: false,
    execution_permitted: false,
    grants_authority: false,
    authority_effect: false
  });
}
