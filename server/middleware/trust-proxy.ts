// Resolves the Express `trust proxy` setting from the TRUST_PROXY environment variable.
//
// Why this matters: req.ip (used by the rate limiters and webhook limiters) and
// req.protocol read X-Forwarded-For / X-Forwarded-Proto only when Express trusts the
// hop that sent them. With trust proxy = true, any client can forge X-Forwarded-For
// and pick its own rate-limit bucket.
//
// TRUST_PROXY accepts:
//   unset, empty, "false", "0"   -> false (default). req.ip is the socket address.
//   a positive integer, e.g. "1" -> trust that many hops of X-Forwarded-For.
//   a list of addresses or ranges, e.g. "10.0.0.5" or "10.0.0.0/8,127.0.0.1"
//                                -> trust only hops from those addresses.
//   "loopback", "linklocal", "uniquelocal" -> Express named ranges.
// "true" is refused (treated as false, with a warning) because it trusts every client.
// Set the value to match the proxy in front of the app. See docs/proxy/desk-modes.nginx.conf.

export type TrustProxySetting = boolean | number | string;

const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

export function resolveTrustProxy(raw: string | undefined | null): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false' || value === '0') {
    return false;
  }
  if (value.toLowerCase() === 'true') {
    console.warn('[Security] TRUST_PROXY=true is refused because it lets clients spoof req.ip. Using false.');
    return false;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length > 0 && parts.every((part) => NAMED_RANGES.has(part) || part.includes('.') || part.includes(':'))) {
    return parts.join(',');
  }
  console.warn(`[Security] TRUST_PROXY value "${value}" is not recognised. Using false.`);
  return false;
}
