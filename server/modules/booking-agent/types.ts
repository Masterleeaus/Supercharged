/*
 * Booking agent types. Ported from PhoneCallAgent's BookingToolDefinitions.php
 * and BookingToolHandler.php. No runtime imports: this file is types and
 * constants only.
 */

export const BOOKING_TOOL_NAMES = ['create_booking', 'cancel_booking', 'reschedule_booking'] as const;

export type BookingToolName = (typeof BOOKING_TOOL_NAMES)[number];

/**
 * The verified caller. Every field comes from the authenticated session or the
 * agent runtime, never from the tool input the model produced.
 */
export interface BookingCaller {
  companyId: string;
  requestedBy: string | null;
  agentId: string | null;
}

export type ApprovalGateStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type BookingUrgency = 'low' | 'normal' | 'high' | 'critical';

/** Request the dispatcher sends to the approvals gate. */
export interface BookingGateRequest {
  companyId: string;
  requestedBy: string | null;
  agentId: string | null;
  action: BookingToolName;
  params: Record<string, unknown>;
  context: Record<string, unknown>;
  urgency: BookingUrgency;
  ttlMs: number;
}

/**
 * Structural subset of ApprovalService.gateAction's result. Only `status` decides
 * whether a booking may run.
 */
export interface BookingGateResult {
  status: ApprovalGateStatus;
  approval: { id: string };
  decision: string;
  policyId: string | null;
}

/** The approvals gate, injected. ApprovalService satisfies this shape. */
export interface BookingGate {
  gateAction(request: BookingGateRequest): Promise<BookingGateResult>;
}

export type BookingOutcome =
  | { outcome: 'executed'; message: string; bookingUid: string | null }
  | {
      outcome: 'refused';
      reason: 'awaiting_approval' | 'gate_denied' | 'gate_error';
      message: string;
      approvalId?: string;
    }
  | { outcome: 'invalid_input'; message: string; issues: string[] }
  | { outcome: 'unknown_tool'; message: string }
  | { outcome: 'failed'; message: string };
