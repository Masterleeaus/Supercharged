/** Types and the HTTP error shared by the flow test-call modules. */
import type { agents, flows } from "@shared/schema";
import type { ElevenLabsPoolService } from "../../services/elevenlabs-pool";

export class FlowTestHttpError extends Error {
  constructor(public statusCode: number, public body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : 'Flow test error');
  }
}

export type FlowTestAgent = typeof agents.$inferSelect;
export type FlowTestFlow = typeof flows.$inferSelect;
export type FlowTestElevenLabsCredential = NonNullable<Awaited<ReturnType<typeof ElevenLabsPoolService.getCredentialForAgent>>>;
export type FlowTestCompleteQueue = (resolvedCallId: string) => Promise<void>;
export type FlowTestFailQueue = (reason: string) => Promise<void>;
export type FlowTestCampaignWarning = { message: string; campaignName: string } | null;
