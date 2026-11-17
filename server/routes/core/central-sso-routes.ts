/** Mounts Central sign-in start and callback. Called from server/routes.ts only when
 * loadCentralSsoConfig(process.env).enabled is true (CENTRAL_SSO_ENABLED === 'true').
 * Default is off: with the flag unset, no Central route exists and native login is unchanged.
 * The callback still fails closed until the Central entitlement check (#194) is configured.
 */
import type { Express, Request, Response } from "express";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { refreshTokens } from "@shared/schema";
import { loadCentralSsoConfig, type CentralSsoConfig } from "../../infrastructure/central-sso/config.ts";
import { createDiscoveryClient, createJwksClient, type Jwk } from "../../infrastructure/central-sso/discovery.ts";
import { createCentralOidcFlow } from "../../infrastructure/central-sso/oidc-flow.ts";
import { createDatabasePendingStore } from "../../infrastructure/central-sso/pending-store-db.ts";
import { createDeskCentralAccountResolver } from "../../infrastructure/central-sso/account-resolver.ts";
import { createDeskCentralLinkQuery } from "../../infrastructure/central-sso/link-query.ts";
import { createCentralSignIn } from "../../infrastructure/central-sso/sign-in.ts";
import { createCentralSsoHandlers, CALLBACK_PATH, START_PATH, type SsoRequest, type SsoResponse } from "../../infrastructure/central-sso/http-handlers.ts";
import { createRefreshTokenData, generateShortAccessToken, setRefreshTokenCookie } from "../../middleware/auth";
import { isCompanyId } from "../../infrastructure/database/tenant-context.ts";
import { logger } from "../../utils/logger";

export function mountCentralSso(app: Express, config: CentralSsoConfig = loadCentralSsoConfig(process.env)): boolean {
  if (config.enabled !== true) return false;

  const discovery = createDiscoveryClient({ issuer: config.issuer });
  const jwksByUri = new Map<string, (kid: string) => Promise<Jwk | null>>();
  const jwksKeys = async (kid: string): Promise<Jwk | null> => {
    const meta = await discovery();
    let getKey = jwksByUri.get(meta.jwksUri);
    if (!getKey) {
      getKey = createJwksClient({ jwksUri: meta.jwksUri });
      jwksByUri.set(meta.jwksUri, getKey);
    }
    return getKey(kid);
  };

  const flow = createCentralOidcFlow({
    config,
    discovery,
    jwksKeys,
    pending: createDatabasePendingStore({ db: pool }),
  });

  const resolve = createDeskCentralAccountResolver({
    // Central entitlement check: no endpoint contract in this repo yet (#194). Fail closed.
    authoriseCentral: async () => false,
    queryLink: createDeskCentralLinkQuery(pool),
    resolveCompanyBinding: async (companyId: string) => {
      if (!isCompanyId(companyId)) return null;
      const rows = await pool.query("SELECT id FROM companies WHERE id = $1::uuid LIMIT 1", [companyId]);
      return rows.rows.length === 1 ? companyId : null;
    },
  });

  const signIn = createCentralSignIn({
    complete: (input) => flow.complete(input),
    resolve,
    issueNativeToken: async (userId, role, companyId) => generateShortAccessToken(userId, role, companyId),
  });

  const handlers = createCentralSsoHandlers({
    flow,
    signIn,
    establishSession: async (account, req, res) => {
      // Local user record is the authority for active status and company scope.
      const user = await storage.getUser(account.userId);
      if (!user || user.isActive === false || user.companyId !== account.companyId) return false;
      const rt = createRefreshTokenData(
        user.id,
        typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
        req.ip,
      );
      await db.insert(refreshTokens).values({
        userId: user.id,
        token: rt.hashedToken,
        expiresAt: rt.expiresAt,
        userAgent: rt.userAgent,
        ipAddress: rt.ipAddress,
        lastUsedAt: new Date(),
      });
      setRefreshTokenCookie(res as unknown as Response, rt.token);
      return true;
    },
  });

  app.get(START_PATH, (req: Request, res: Response) =>
    handlers.start(req as unknown as SsoRequest, res as unknown as SsoResponse),
  );
  app.get(CALLBACK_PATH, (req: Request, res: Response) =>
    handlers.callback(req as unknown as SsoRequest, res as unknown as SsoResponse),
  );
  logger.info("Central sign-in routes mounted", undefined, "Auth");
  return true;
}
