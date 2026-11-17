/** Framework-free start and callback handlers for Central sign-in.
 * The Express wiring lives in server/routes/core/central-sso-routes.ts. Failures return fixed
 * codes only; provider errors, tokens and secrets are never echoed back.
 */
import {TXN_COOKIE, txnCookieHeader, clearTxnCookieHeader, type FlowStart} from './oidc-flow.ts';
import type {DeskAccount} from './account-resolver.ts';
import type {SignInResult} from './sign-in.ts';

export type SsoRequest = {query: Record<string, unknown>; cookies?: Record<string, unknown>; headers: Record<string, unknown>; ip?: string};
export type SsoResponse = {
 status(code: number): SsoResponse;
 json(body: unknown): unknown;
 setHeader(name: string, value: string | string[]): unknown;
 redirect(status: number, url: string): unknown;
};

export const CALLBACK_PATH = '/api/auth/central/callback';
export const START_PATH = '/api/auth/central/start';

export function createCentralSsoHandlers({flow, signIn, establishSession, landingPath = '/'}: {
 flow: {start(): Promise<FlowStart>};
 signIn: (input: {query: Record<string, unknown>; cookieState: unknown}) => Promise<SignInResult>;
 /** Creates the local refresh session for a verified account. Returns false to refuse. */
 establishSession: (account: DeskAccount, req: SsoRequest, res: SsoResponse) => Promise<boolean>;
 landingPath?: string;
}) {
 return {
  async start(req: SsoRequest, res: SsoResponse): Promise<void> {
   try {
    const started = await flow.start();
    if (started.ok === false) {
     res.status(503).json({error: 'central_sign_in_unavailable'});
     return;
    }
    res.setHeader('Set-Cookie', txnCookieHeader(started.state));
    res.redirect(302, started.redirectUrl);
   } catch {
    res.status(503).json({error: 'central_sign_in_unavailable'});
   }
  },

  async callback(req: SsoRequest, res: SsoResponse): Promise<void> {
   // The transaction cookie is single use: clear it on every outcome.
   res.setHeader('Set-Cookie', clearTxnCookieHeader());
   try {
    const cookieState = req.cookies?.[TXN_COOKIE];
    const result = await signIn({query: req.query, cookieState});
    if (result.ok === false) {
     res.status(401).json({error: 'central_sign_in_failed'});
     return;
    }
    const established = await establishSession(result.account, req, res);
    if (!established) {
     res.status(401).json({error: 'central_sign_in_failed'});
     return;
    }
    res.redirect(302, landingPath);
   } catch {
    res.status(500).json({error: 'central_sign_in_failed'});
   }
  },
 };
}
