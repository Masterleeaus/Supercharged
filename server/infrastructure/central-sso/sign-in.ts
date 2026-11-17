/** Joins the verified Central callback to the existing local account resolver and native session gate.
 * Mounted only by server/routes/core/central-sso-routes.ts, behind CENTRAL_SSO_ENABLED.
 */
import type {DeskAccount} from './account-resolver.ts';
import type {FlowComplete, FlowFailure} from './oidc-flow.ts';
import type {VerifiedDeskCentralSelection} from './selection-contract.ts';
import {createDeskCentralSessionGate} from './session-gate.ts';

export type SignInResult = {ok: true; token: string; account: DeskAccount} | {ok: false; reason: string};

export function createCentralSignIn({complete, resolve, issueNativeToken}: {
 complete: (input: {query: Record<string, unknown>; cookieState: unknown}) => Promise<FlowComplete>;
 resolve: (identity: unknown) => Promise<DeskAccount | null>;
 issueNativeToken: (userId: string, role: string, companyId: string) => Promise<string>;
}) {
 return async function signIn(input: {query: Record<string, unknown>; cookieState: unknown}): Promise<SignInResult> {
  const flow = await complete(input);
  if (flow.ok === false) return {ok: false, reason: flow.reason as FlowFailure | string};
  const selection: VerifiedDeskCentralSelection = flow.selection;
  // Keep the resolved account so the caller can create the local refresh session.
  const holder: {account: DeskAccount | null} = {account: null};
  const gate = createDeskCentralSessionGate({
   resolve: async (identity) => {
    const account = await resolve(identity);
    holder.account = account;
    return account;
   },
   issueNativeToken,
  });
  const token = await gate(selection);
  // Local account is required. A missing or revoked link fails closed with a fixed reason.
  if (!token || !holder.account) return {ok: false, reason: 'no_local_account'};
  return {ok: true, token, account: holder.account};
 };
}
