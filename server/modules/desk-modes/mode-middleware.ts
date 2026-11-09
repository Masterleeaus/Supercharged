// Express-compatible middleware that decides which Desk mode a request belongs to.
// It does not import Express. It takes the request, response and next callback shapes
// it needs, so it can be tested without a server.
//
// Fails closed: a request for an unknown host gets 404 and never reaches a mode.

import { resolveDeskMode, type DeskMode, type DeskModeConfig } from './mode-resolver.ts';
import { isModuleAllowed } from './mode-modules.ts';

export interface ModeRequest {
  headers: Record<string, string | string[] | undefined>;
  deskMode?: DeskMode;
  deskHost?: string;
}

export interface ModeResponse {
  statusCode: number;
  status(code: number): ModeResponse;
  json(body: unknown): void;
}

export type NextFn = (err?: unknown) => void;

function hostOf(req: ModeRequest): string | undefined {
  // Host only. X-Forwarded-Host is client-controlled and is never read.
  const raw = req.headers['host'];
  if (Array.isArray(raw)) return undefined; // Repeated Host is invalid.
  return raw;
}

export function deskModeMiddleware(config: DeskModeConfig) {
  return function resolveMode(req: ModeRequest, res: ModeResponse, next: NextFn): void {
    const result = resolveDeskMode(hostOf(req), config);
    if (!result.ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    req.deskMode = result.mode;
    req.deskHost = result.host;
    next();
  };
}

// Guard for a route group: a route mounted under one mode cannot be reached from the other.
export function requireModule(moduleName: string) {
  return function guard(req: ModeRequest, res: ModeResponse, next: NextFn): void {
    if (!req.deskMode || !isModuleAllowed(req.deskMode, moduleName)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    next();
  };
}
