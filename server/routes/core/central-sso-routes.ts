/** Central SSO sign-in start and callback routes. Mounted always, but both paths
 * answer 404 unless CENTRAL_SSO_ENABLED is exactly 'true'. The existing login
 * routes are not touched. Flow and sign-in are injected; when enabled and not
 * wired, the routes fail closed with 503.
 */
import express, { type Express, type Request, type Response, type Router } from "express";
import { TXN_COOKIE, clearTxnCookieHeader, txnCookieHeader, type FlowStart } from "../../infrastructure/central-sso/oidc-flow.ts";
import type { SignInResult } from "../../infrastructure/central-sso/sign-in.ts";

export const CENTRAL_START_PATH = "/auth/central/start";
export const CENTRAL_CALLBACK_PATH = "/auth/central/callback";

export type CentralSsoRouteDeps = {
  enabled: boolean;
  flow?: { start(): Promise<FlowStart> };
  signIn?: (input: { query: Record<string, unknown>; cookieState: unknown }) => Promise<SignInResult>;
};

/** Returns the cookie value only when the name appears exactly once. Duplicates are treated as absent. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const found: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) found.push(part.slice(i + 1).trim());
  }
  return found.length === 1 ? found[0] : undefined;
}

export function createCentralSsoRouter({ enabled, flow, signIn }: CentralSsoRouteDeps): Router {
  const router = express.Router();

  router.get(CENTRAL_START_PATH, async (_req: Request, res: Response) => {
    if (!enabled) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (!flow) {
      res.status(503).json({ success: false, reason: "not_configured" });
      return;
    }
    try {
      const started = await flow.start();
      if (started.ok === false) {
        res.status(503).json({ success: false, reason: started.reason });
        return;
      }
      res.setHeader("Set-Cookie", txnCookieHeader(started.state));
      res.redirect(302, started.redirectUrl);
    } catch {
      res.status(503).json({ success: false, reason: "provider_error" });
    }
  });

  router.get(CENTRAL_CALLBACK_PATH, async (req: Request, res: Response) => {
    if (!enabled) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    // The transaction cookie is single use: clear it on every outcome.
    res.setHeader("Set-Cookie", clearTxnCookieHeader());
    if (!signIn) {
      res.status(503).json({ success: false, reason: "not_configured" });
      return;
    }
    try {
      const result = await signIn({
        query: { ...req.query } as Record<string, unknown>,
        cookieState: readCookie(req.headers.cookie, TXN_COOKIE),
      });
      if (result.ok === false) {
        res.status(401).json({ success: false, reason: result.reason });
        return;
      }
      res.json({ success: true, token: result.token });
    } catch {
      res.status(401).json({ success: false, reason: "sign_in_failed" });
    }
  });

  return router;
}

/** Mounts the Central SSO routes. Enabled state is read from CENTRAL_SSO_ENABLED only. */
export function registerCentralSsoRoutes(app: Express, deps: Partial<Omit<CentralSsoRouteDeps, "enabled">> = {}): void {
  const enabled = process.env.CENTRAL_SSO_ENABLED === "true";
  app.use(createCentralSsoRouter({ enabled, ...deps }));
}
