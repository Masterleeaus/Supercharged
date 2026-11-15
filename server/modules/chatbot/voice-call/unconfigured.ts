/**
 * Fail-closed ports for the voice-call service at boot. No telephony provider, billing ledger, plan table or chatbot
 * lookup is wired yet (owner decisions). Until they are, the service is constructed and the quota sweep runs, but:
 * - no call can start: the quota reports "not in plan" (0), the chatbot gate reports absent, the credential source
 *   reports none, and the credit ledger reports no balance;
 * - the provider refuses every operation with a fixed message;
 * - no callback host is allowed.
 * Replace these with real adapters when the owner decides the provider and the ledger. Nothing here calls a network.
 */
import type { CallProvider, CallStartRequest, CallSession, CallWebhookInput, CallProviderEvent } from "../contracts/index.ts";
import type { ChatbotGate, CallQuotaPort, CreditLedger, CredentialSource } from "./ports.ts";

export const UNCONFIGURED_MESSAGE = "voice call provider is not configured";

export class UnconfiguredCallProvider implements CallProvider {
  readonly key = "unconfigured";

  async startCall(_request: CallStartRequest, _credentials: Readonly<Record<string, string>>): Promise<CallSession> {
    throw new Error(UNCONFIGURED_MESSAGE);
  }

  async hangUp(): Promise<boolean> {
    throw new Error(UNCONFIGURED_MESSAGE);
  }

  /** Fails closed: nothing is verified, so every webhook is refused. */
  async verifyWebhook(_companyId: string, _input: CallWebhookInput): Promise<boolean> {
    return false;
  }

  parseWebhook(_companyId: string, _rawBody: string): CallProviderEvent[] {
    return [];
  }
}

/** Plan lookup. 0 means "not in plan", so every start is refused. */
export const unconfiguredQuota: CallQuotaPort = {
  async secondsLimitFor() {
    return 0;
  },
};

/** No chatbot is found, so no call can be attached to one. */
export const unconfiguredChatbotGate: ChatbotGate = {
  async exists() {
    return false;
  },
};

/** No provider credentials exist, so the service fails closed. */
export const unconfiguredCredentials: CredentialSource = {
  async load() {
    return null;
  },
};

/** No balance, so every start is refused. A charge is refused too, so a transcript can never be billed for free. */
export const unconfiguredCredits: CreditLedger = {
  async hasBalance() {
    return false;
  },
  async chargeTranscript() {
    throw new Error("credit ledger is not configured");
  },
};
