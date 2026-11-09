// Desk mode for the trusted session response.
//
// The mode comes from the Host header only, matched against the configured allowlist.
// X-Forwarded-Host is never read. An unknown, missing or malformed host gets the workforce
// default with source 'default'. Route guards still refuse unknown hosts with 404
// (deskModeMiddleware), so the default only shapes the session payload, not access.
//
// Pure: no Express, no environment reads. The caller passes the Host value in.

import { buildModeConfig, resolveDeskMode, type DeskMode, type DeskModeConfig } from './mode-resolver.ts';

/** Production hosts. A host is listed for one mode only (buildModeConfig throws otherwise). */
export const DEFAULT_DESK_MODE_CONFIG: DeskModeConfig = buildModeConfig({
  workforceHosts: 'superchargedat.work',
  commsHosts: 'syncedat.work',
});

export const WORKFORCE_DEFAULT_MODE: DeskMode = 'workforce';

/** Only source=host confirms a configured host. */
export interface SessionDeskMode {
  mode: DeskMode;
  source: 'host' | 'default';
}

export function sessionDeskMode(
  hostHeader: string | string[] | undefined | null,
  config: DeskModeConfig = DEFAULT_DESK_MODE_CONFIG,
): SessionDeskMode {
  // A repeated Host header is not a valid request. Treat it as unknown rather than picking one.
  if (Array.isArray(hostHeader)) return { mode: WORKFORCE_DEFAULT_MODE, source: 'default' };
  const result = resolveDeskMode(hostHeader, config);
  if (result.ok) return { mode: result.mode, source: 'host' };
  return { mode: WORKFORCE_DEFAULT_MODE, source: 'default' };
}
