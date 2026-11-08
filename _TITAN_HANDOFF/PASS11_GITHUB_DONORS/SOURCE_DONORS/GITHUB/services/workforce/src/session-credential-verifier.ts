import { createSessionCredentialVerifier } from "../../../packages/titan-platform/src/security-boundary.js";
import type { HostedWorkforceDependencies } from "./hosted-runtime.js";

/** Trusted startup configuration; audience and native surface are fixed here. */
export type WorkforceSessionCredentialVerifierOptions = Omit<
  Parameters<typeof createSessionCredentialVerifier>[0],
  "audience"
>;

/** Adapt canonical signed session authentication to hosted Workforce ingress.
 * This exposes no issuance, switching, revocation, provisioning, or key creation.
 * The host still revalidates current registry identity before consequential work.
 */
export function createWorkforceSessionCredentialVerifier(
  options: WorkforceSessionCredentialVerifierOptions,
): HostedWorkforceDependencies["credentialVerifier"] {
  const verifier = createSessionCredentialVerifier({ ...options, audience: "workforce" });
  return Object.freeze({
    async verify(authorization: string, control?: { signal: AbortSignal }) {
      try {
        control?.signal.throwIfAborted();
        if (typeof authorization !== "string" || authorization.length > 8192) throw new Error("authentication-denied");
        const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
        if (!match) throw new Error("authentication-denied");
        // Never decode claims independently or derive identity from request fields.
        const { context, provider, subject, credential_expires_at, source_session } = await verifier.authenticate(match[1]);
        control?.signal.throwIfAborted();
        return Object.freeze({
          provider,
          subject,
          session_id: context.session_id,
          device_id: context.device_id,
          session_revision: context.session_revision,
          credential_expires_at,
          ...(source_session ? { source_session } : {}),
          audience: "workforce",
          surface: "zero" as const,
        });
      } catch (error) {
        // Keep tokens, claim values, crypto errors, and registry details private.
        if (error instanceof Error && error.message === "identity-registry-unavailable") {
          throw new Error("identity-registry-unavailable");
        }
        throw new Error("authentication-denied");
      }
    },
  });
}
