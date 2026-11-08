/**
 * Write path from a conversational commerce action to the marketplace write runtime.
 *
 * Two steps, and no other way in:
 * 1. prepare(): stores a proposal and returns a confirmation token, shown once to the seller or staff member who
 *    must confirm. Nothing reaches the marketplace.
 * 2. confirmAndExecute(): calls runtime.confirm() with that token. Only when the proposal comes back "approved"
 *    does it call runtime.execute(). A bad token, an expired token, or a blocked proposal stops it before execute.
 *
 * Flag: CHATBOT_MARKETPLACE_WRITE_ENABLED must be exactly "true". It is checked here first, so when the flag is
 * off the runtime is never called. The runtime checks it again on every call.
 *
 * Authority (owner or admin role, owning the connection) is enforced by the marketplace runtime, not here.
 */
import { CONTRACT_FLAGS, readFlag, type FlagEnv } from "../../contracts/index.ts";
import type { MarketplaceActor, MarketplaceWriteRuntime, PrepareWriteInput } from "../marketplace/index.ts";
import { CommerceError } from "./errors.ts";

export interface MarketplaceWritePathDeps {
  runtime: MarketplaceWriteRuntime;
  env: FlagEnv;
}

export interface PreparedMarketplaceWrite {
  proposalId: string;
  status: string;
  /** Null when the write is blocked by a conflict. Only a non-null token can be confirmed. */
  confirmationToken: string | null;
  conflictCount: number;
}

export interface ExecutedMarketplaceWrite {
  proposalId: string;
  status: string;
  errorCode: string | null;
}

export interface MarketplaceWritePath {
  prepare(companyId: string, actor: MarketplaceActor, input: PrepareWriteInput): Promise<PreparedMarketplaceWrite>;
  confirmAndExecute(companyId: string, actor: MarketplaceActor, proposalId: string, confirmationToken: string): Promise<ExecutedMarketplaceWrite>;
}

export function createMarketplaceWritePath(deps: MarketplaceWritePathDeps): MarketplaceWritePath {
  function requireFlag(): void {
    if (!readFlag(CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED, deps.env)) {
      throw new CommerceError("flag_disabled", "Marketplace writes are disabled for this installation.");
    }
  }

  return {
    async prepare(companyId, actor, input) {
      requireFlag();
      if (typeof companyId !== "string" || companyId.trim() === "") {
        throw new CommerceError("validation", "company_id is required.", { company_id: "required" });
      }
      const prepared = await deps.runtime.prepare(companyId, actor, input);
      return {
        proposalId: prepared.proposal.id,
        status: prepared.proposal.status,
        confirmationToken: prepared.confirmationToken,
        conflictCount: prepared.proposal.conflicts.length,
      };
    },

    async confirmAndExecute(companyId, actor, proposalId, confirmationToken) {
      requireFlag();
      if (typeof confirmationToken !== "string" || confirmationToken.trim() === "") {
        throw new CommerceError("validation", "A confirmation token is required.", { confirmation_token: "required" });
      }
      const confirmed = await deps.runtime.confirm(companyId, actor, proposalId, confirmationToken);
      if (confirmed.status !== "approved") {
        throw new CommerceError("conflict", "The marketplace write is not approved, so nothing was sent.");
      }
      const executed = await deps.runtime.execute(companyId, actor, proposalId);
      return { proposalId: executed.id, status: executed.status, errorCode: executed.errorCode };
    },
  };
}
