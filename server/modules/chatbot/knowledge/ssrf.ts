/**
 * SSRF guard for URL sources. Every URL the knowledge base fetches passes through here first, and again for
 * every redirect hop. The PHP LinkParser called file_get_contents on any URL, with no guard. That gap is not
 * ported.
 *
 * Refused:
 * - schemes other than http and https (file:, ftp:, gopher:, data:, and so on)
 * - URLs with credentials
 * - ports other than 80 and 443
 * - localhost names, single-label hosts, and internal suffixes (.local, .internal, and similar)
 * - IP literals and resolved addresses in loopback, private, link-local (169.254.169.254), CGNAT,
 *   multicast, reserved and documentation ranges, including IPv4-mapped and NAT64 IPv6 forms
 *
 * Address lookup is injected, so tests never touch DNS.
 */

export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

export type UrlRefusalReason = "invalid" | "scheme" | "credentials" | "port" | "host" | "address" | "resolution";

export class UrlRefusedError extends Error {
  readonly reason: UrlRefusalReason;

  constructor(reason: UrlRefusalReason, message: string) {
    super(message);
    this.name = "UrlRefusedError";
    this.reason = reason;
  }
}

export const ALLOWED_PORTS: ReadonlySet<string> = new Set(["", "80", "443"]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa", ".intranet"];

/** True for any IPv4 address that is not public. Malformed input is treated as blocked. */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 shared address space
    (a === 169 && b === 254) || // link-local, includes the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol and TEST-NET-1
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast and reserved
  );
}

/** Expands an IPv6 literal to eight 16-bit groups. Returns null when it cannot be parsed. */
export function parseIPv6(input: string): number[] | null {
  let ip = input.toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);

  const tail = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = tail[2].split(".").map(Number);
    if (v4.some((n) => n > 255)) return null;
    ip = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const after = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - after.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...after];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function ipv4From(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for any IPv6 address that is not public. Unparseable input is treated as blocked. */
export function isPrivateIPv6(ip: string): boolean {
  const n = parseIPv6(ip);
  if (!n) return true;
  const zeroTo = (count: number) => n.slice(0, count).every((x) => x === 0);

  if (zeroTo(8)) return true; // ::
  if (zeroTo(7) && n[7] === 1) return true; // ::1
  if (zeroTo(5) && n[5] === 0xffff) return isPrivateIPv4(ipv4From(n[6], n[7])); // ::ffff:0:0/96
  if (n[0] === 0x64 && n[1] === 0xff9b && n[2] === 0 && n[3] === 0 && n[4] === 0 && n[5] === 0) {
    return isPrivateIPv4(ipv4From(n[6], n[7])); // 64:ff9b::/96 NAT64
  }
  if (n[0] === 0x2002) return isPrivateIPv4(ipv4From(n[1], n[2])); // 6to4
  if (n[0] === 0x2001 && n[1] === 0) return true; // Teredo
  if (n[0] === 0x2001 && n[1] === 0x0db8) return true; // documentation
  if ((n[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((n[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((n[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((n[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** A URL that passed the check, with the addresses it was checked against. */
export interface CheckedHttpTarget {
  url: URL;
  /** Every address the check accepted, unbracketed. A pinned connect must use one of these. */
  addresses: readonly string[];
}

/**
 * Returns the parsed URL when it may be fetched. Throws UrlRefusedError otherwise.
 * The check covers the name as written and every address the resolver returns.
 */
export async function assertPublicHttpUrl(raw: string, resolve: AddressResolver): Promise<URL> {
  return (await checkPublicHttpTarget(raw, resolve)).url;
}

/**
 * Like assertPublicHttpUrl, but also returns the checked addresses. The resolver runs once here. A caller that
 * connects must connect to one of the returned addresses (see pinned-http.ts), so a DNS answer that changes
 * after this call cannot move the connection to a private address.
 */
export async function checkPublicHttpTarget(raw: string, resolve: AddressResolver): Promise<CheckedHttpTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRefusedError("invalid", "The URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlRefusedError("scheme", "Only http and https URLs can be used.");
  }
  if (url.username || url.password) {
    throw new UrlRefusedError("credentials", "URLs with a username or password are not allowed.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlRefusedError("port", "Only the standard web ports can be used.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new UrlRefusedError("invalid", "The URL has no host.");

  if (host.startsWith("[")) {
    const literal = host.slice(1, -1);
    if (isPrivateIPv6(literal)) throw new UrlRefusedError("address", "That address is not public.");
    return { url, addresses: [literal] };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIPv4(host)) throw new UrlRefusedError("address", "That address is not public.");
    return { url, addresses: [host] };
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UrlRefusedError("host", "That host is not public.");
  }
  if (!host.includes(".")) {
    throw new UrlRefusedError("host", "Single-label host names are not allowed.");
  }

  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UrlRefusedError("resolution", "The host name could not be resolved.");
  }
  if (addresses.length === 0) {
    throw new UrlRefusedError("resolution", "The host name could not be resolved.");
  }
  for (const address of addresses) {
    const blocked = address.includes(":") ? isPrivateIPv6(address) : isPrivateIPv4(address);
    if (blocked) throw new UrlRefusedError("address", "That host resolves to a non-public address.");
  }
  return { url, addresses: [...addresses] };
}
