// Domain allowlist decision for the public widget routes.
// Kept free of database and engine imports so the fail-closed rule can be tested on its own.

export interface WidgetRequestHeaders {
  origin?: string;
  referer?: string;
}

// Host name of the page that made the request, taken from Origin, then Referer.
// Returns '' when neither header is present or usable.
export function widgetRequestDomain(headers: WidgetRequestHeaders): string {
  const origin = headers.origin || headers.referer || '';
  try {
    const url = new URL(origin);
    return url.hostname;
  } catch {
    return origin.replace(/^https?:\/\//, '').split('/')[0];
  }
}

// Empty allowlist: the widget is open to any domain (unchanged behaviour).
// Non-empty allowlist: fail closed. A request with no domain cannot match an entry, so it is refused.
export function isWidgetDomainAllowed(
  allowedDomains: readonly string[] | null | undefined,
  requestDomain: string,
): boolean {
  if (!allowedDomains || allowedDomains.length === 0) {
    return true;
  }
  if (!requestDomain) {
    return false;
  }
  const normalizedDomain = requestDomain.toLowerCase().replace(/^www\./, '');
  return allowedDomains.some(allowed => {
    const normalizedAllowed = allowed.toLowerCase().replace(/^www\./, '');
    if (normalizedAllowed.startsWith('*.')) {
      const baseDomain = normalizedAllowed.slice(2);
      return normalizedDomain === baseDomain || normalizedDomain.endsWith('.' + baseDomain);
    }
    return normalizedDomain === normalizedAllowed;
  });
}
