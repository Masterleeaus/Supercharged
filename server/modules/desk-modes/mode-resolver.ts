// Desk runs as one codebase with two modes, each served on its own domain:
//   - "workforce": the AI workforce, served on SuperchargedAt.Work
//   - "comms":     omnichannel inbox, comms campaigns and marketing, on SyncedAt.Work
//
// Pure functions only: no Express, no database, no environment reads. The caller
// passes the host header and the mode config in. Fails closed: an unknown host
// gets no mode and no modules.

export type DeskMode = 'workforce' | 'comms';

export interface DeskModeConfig {
  workforceHosts: readonly string[];
  commsHosts: readonly string[];
}

export type ModeResolution =
  | { ok: true; mode: DeskMode; host: string }
  | { ok: false; reason: 'missing_host' | 'malformed_host' | 'unknown_host' };

const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

// Lower-case, strip a trailing dot and a numeric port, and reject anything that
// is not a plain hostname (no scheme, path, credentials or spaces).
export function normaliseHost(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (host === '') return null;
  const portMatch = /^(.*):(\d{1,5})$/.exec(host);
  if (portMatch && !host.startsWith('[')) {
    const port = Number(portMatch[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    host = portMatch[1];
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  if (!HOST_PATTERN.test(host)) return null;
  return host;
}

// Config hosts are normalised the same way. A host listed for both modes is a
// configuration error and throws at startup rather than picking one silently.
export function buildModeConfig(input: {
  workforceHosts?: string | readonly string[];
  commsHosts?: string | readonly string[];
}): DeskModeConfig {
  const workforceHosts = toHostList(input.workforceHosts);
  const commsHosts = toHostList(input.commsHosts);
  const overlap = workforceHosts.filter((h) => commsHosts.includes(h));
  if (overlap.length > 0) {
    throw new Error(`desk-modes: host listed for both modes: ${overlap.join(', ')}`);
  }
  if (workforceHosts.length === 0 || commsHosts.length === 0) {
    throw new Error('desk-modes: both modes need at least one host');
  }
  return { workforceHosts, commsHosts };
}

function toHostList(value: string | readonly string[] | undefined): string[] {
  const parts = typeof value === 'string' ? value.split(',') : [...(value ?? [])];
  const out: string[] = [];
  for (const part of parts) {
    const host = normaliseHost(part);
    if (host === null) {
      throw new Error(`desk-modes: invalid configured host: ${String(part)}`);
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export function resolveDeskMode(
  hostHeader: string | undefined | null,
  config: DeskModeConfig,
): ModeResolution {
  if (hostHeader === undefined || hostHeader === null || String(hostHeader).trim() === '') {
    return { ok: false, reason: 'missing_host' };
  }
  const host = normaliseHost(hostHeader);
  if (host === null) return { ok: false, reason: 'malformed_host' };
  if (config.workforceHosts.includes(host)) return { ok: true, mode: 'workforce', host };
  if (config.commsHosts.includes(host)) return { ok: true, mode: 'comms', host };
  return { ok: false, reason: 'unknown_host' };
}
