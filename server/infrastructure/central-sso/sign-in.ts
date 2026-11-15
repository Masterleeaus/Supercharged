/** Joins the verified Central callback to the existing local account resolver and native session gate.
 * Not mounted on any route. The route wiring is a separate, flag-gated step.
 */
import type {DeskAccount} from './account-resolver.ts';
import type {FlowComplete, FlowFailure} from './oidc-flow.ts';
import type {VerifiedDeskCentralSelection} from './selection-contract.ts';
import {createDeskCentralSessionGate} from './session-gate.ts';

export type SignInResult = {ok: true; token: string} | {ok: false; reason: string};

export function createCentralSignIn({complete, resolve, issueNativeToken}: {
 complete: (input: {query: Record<string, unknown>; cookieState: unknown}) => Promise<FlowComplete>;
 resolve: (identity: unknown) => Promise<DeskAccount | null>;
 issueNativeToken: (userId: string, role: string, companyId: string) => Promise<string>;
}) {
 const gate = createDeskCentralSessionGate({resolve, issueNativeToken});
 return async function signIn(input: {query: Record<string, unknown>; cookieState: unknown}): Promise<SignInResult> {
  const flow = await complete(input);
  if (!flow.ok) return {ok: false, reason: flow.reason as FlowFailure | string};
  const selection: VerifiedDeskCentralSelection = flow.selection;
  const token = await gate(selection);
  // Local account is required. A missing or revoked link fails closed with a fixed reason.
  if (!token) return {ok: false, reason: 'no_local_account'};
  return {ok: true, token};
 };
}
