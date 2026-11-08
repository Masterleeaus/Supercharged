/**
 * Client address for the public widget, behind reverse proxies.
 *
 * Rules:
 * - X-Forwarded-For is read only when the TCP peer is a configured trusted proxy. Otherwise the peer address is used,
 *   and any forwarded header a caller sends is ignored.
 * - The chain is walked from the right. The first address that is not a trusted proxy is the client. Entries to the
 *   left of it were supplied by the client and are never used.
 * - A malformed chain, or one longer than MAX_FORWARDED_HOPS, is not trusted: the peer address is used instead.
 * - Trusted proxies are configured as exact addresses or IPv4/IPv6 CIDR blocks. Wildcards and /0 are rejected.
 * - Addresses are compared in canonical form, so 1.2.3.4 and ::ffff:1.2.3.4 are the same client.
 *
 * Pure functions, no network. Node's net module is used only to classify text.
 */
import { isIP } from "node:net";

export const MAX_FORWARDED_HOPS = 16;
const MAX_FORWARDED_HEADER_LENGTH = 1024;

export interface ParsedIp {
  family: 4 | 6;
  /** Address as an unsigned integer. 32 bits for IPv4, 128 bits for IPv6. */
  value: bigint;
}

export interface TrustedProxy {
  family: 4 | 6;
  network: bigint;
  /** Number of leading bits that must match. Full width for a single address. */
  prefix: number;
  /** Canonical text for logs and tests. */
  label: string;
}

export interface TrustedProxyParse {
  proxies: TrustedProxy[];
  /** Entries that were not valid, or that were refused (wildcards, /0). They are not trusted. */
  rejected: string[];
}

function parseIpv4(text: string): bigint | null {
  if (isIP(text) !== 4) return null;
  const parts = text.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n);
}

function parseIpv6(text: string): bigint | null {
  if (isIP(text) !== 6) return null;
  let work = text;
  let v4Tail = 0n;
  if (work.includes(".")) {
    // An embedded IPv4 tail (for example ::ffff:1.2.3.4) fills the last 32 bits.
    const idx = work.lastIndexOf(":");
    const v4 = parseIpv4(work.slice(idx + 1));
    if (v4 === null) return null;
    v4Tail = v4;
    work = `${work.slice(0, idx + 1)}0:0`;
  }
  const parts = work.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  let groups: string[];
  if (parts.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    const n = Number.parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    value = (value << 16n) + BigInt(n);
  }
  return value | v4Tail;
}

// ::ffff:0:0/96. After shifting out the low 32 bits, the top 96 bits must equal 0xffff.
const IPV4_MAPPED_TOP = 0xffffn;

/** Parses an address. IPv4-mapped IPv6 addresses are returned as IPv4. Returns null for anything else. */
export function parseIp(raw: unknown): ParsedIp | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0 || text.length > 64) return null;
  const v4 = parseIpv4(text);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseIpv6(text);
  if (v6 === null) return null;
  if ((v6 >> 32n) === IPV4_MAPPED_TOP) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

/** Canonical text: dotted IPv4, or fully expanded lower-case IPv6. Used as the rate-limit key part. */
export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) {
    const v = ip.value;
    return [(v >> 24n) & 0xffn, (v >> 16n) & 0xffn, (v >> 8n) & 0xffn, v & 0xffn].join(".");
  }
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((ip.value >> shift) & 0xffffn).toString(16));
  }
  return groups.join(":");
}

/** Canonical text for any address string, or null when it does not parse. */
export function canonicalIp(raw: unknown): string | null {
  const parsed = parseIp(raw);
  return parsed === null ? null : formatIp(parsed);
}

/** Parses the configured proxy list, for example "10.0.0.5, 10.1.0.0/16, 2001:db8::/32". Invalid entries are dropped. */
export function parseTrustedProxies(raw: string | undefined | null): TrustedProxyParse {
  const proxies: TrustedProxy[] = [];
  const rejected: string[] = [];
  if (!raw) return { proxies, rejected };
  for (const piece of raw.split(",")) {
    const entry = piece.trim();
    if (entry.length === 0) continue;
    if (entry === "*" || entry.endsWith("/0")) {
      rejected.push(entry);
      continue;
    }
    const [addressPart, prefixPart, ...more] = entry.split("/");
    const ip = parseIp(addressPart);
    if (ip === null || more.length > 0) {
      rejected.push(entry);
      continue;
    }
    const width = ip.family === 4 ? 32 : 128;
    let prefix = width;
    if (prefixPart !== undefined) {
      if (!/^\d{1,3}$/.test(prefixPart)) {
        rejected.push(entry);
        continue;
      }
      prefix = Number(prefixPart);
      if (prefix < 1 || prefix > width) {
        rejected.push(entry);
        continue;
      }
    }
    // Keep only the network bits. The host bits of a CIDR entry are ignored.
    const hostBits = BigInt(width - prefix);
    const network = (ip.value >> hostBits) << hostBits;
    proxies.push({ family: ip.family, network, prefix, label: `${formatIp({ family: ip.family, value: network })}/${prefix}` });
  }
  return { proxies, rejected };
}

/** True when the address falls inside one of the trusted proxy entries. */
export function isTrustedProxy(ip: ParsedIp, proxies: readonly TrustedProxy[]): boolean {
  return proxies.some((p) => {
    if (p.family !== ip.family) return false;
    const width = p.family === 4 ? 32 : 128;
    const hostBits = BigInt(width - p.prefix);
    return (ip.value >> hostBits) << hostBits === p.network;
  });
}

export interface ClientAddressInput {
  /** The TCP peer address, as the server socket reports it. */
  remoteAddress: string | undefined | null;
  /** The X-Forwarded-For header. Node may give an array when the header repeats. */
  forwardedFor?: string | readonly string[] | undefined | null;
  trustedProxies: readonly TrustedProxy[];
}

/**
 * Returns the canonical client address, or null when the peer address is missing or invalid.
 * Callers must treat null as "no client address" and must not share a bucket with other callers.
 */
export function resolveClientIp(input: ClientAddressInput): string | null {
  const peer = parseIp(input.remoteAddress ?? undefined);
  if (peer === null) return null;
  const peerText = formatIp(peer);
  if (!isTrustedProxy(peer, input.trustedProxies)) return peerText;

  const header = Array.isArray(input.forwardedFor)
    ? input.forwardedFor.join(",")
    : (input.forwardedFor as string | null | undefined) ?? "";
  if (header.length === 0 || header.length > MAX_FORWARDED_HEADER_LENGTH) return peerText;

  const hops = header.split(",").map((h) => parseIp(h.trim()));
  if (hops.length > MAX_FORWARDED_HOPS || hops.some((h) => h === null)) return peerText;
  const chain = hops as ParsedIp[];

  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!isTrustedProxy(chain[i], input.trustedProxies)) return formatIp(chain[i]);
  }
  // Every hop is a trusted proxy. The leftmost entry is the furthest address the chain names.
  return formatIp(chain[0]);
}
