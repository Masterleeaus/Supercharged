/**
 * Typed helpers for the human approvals inbox.
 *
 * Server contract (approval-routes.ts, not changed here):
 *   GET  /api/approvals?status=&limit=&cursor=  -> { approvals }   (no cursor today)
 *   POST /api/approvals/:id/approve  { reason? } -> { approval }
 *   POST /api/approvals/:id/reject   { reason }  -> { approval }
 *
 * The list helper maps `approvals` to `items` for the page, and a missing
 * nextCursor is treated as end of list. Decision helpers unwrap `approval`.
 *
 * Requests go through apiRequest from lib/queryClient, so auth refresh and
 * ApiError handling (status + server message) follow the existing Desk pattern.
 */
import { apiRequest } from "@/lib/queryClient";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalItem {
  id: string;
  toolName: string;
  serverName: string;
  /** Already redacted by the server before it reaches the client. */
  arguments: Record<string, unknown> | null;
  status: ApprovalStatus;
  requestedBy: string;
  createdAt: string;
  expiresAt: string | null;
  policyReason: string | null;
}

/**
 * Wire shape of one approval, as serialized by the server's ApprovalView
 * (approval-service.ts). Field names differ from ApprovalItem; mapApprovalWire
 * converts them at the API boundary so the page never sees this shape.
 */
export interface ApprovalWire {
  id: string;
  requestedBy: string | null;
  agentId: string | null;
  action: string;
  urgency: string;
  params: Record<string, unknown>;
  status: ApprovalStatus;
  decision: string | null;
  policyId: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  paramsSha256: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  expiresAt: string | null;
}

/** Wire shape returned by GET /api/approvals. nextCursor is absent today. */
export interface ApprovalListWireResponse {
  approvals: ApprovalWire[];
  nextCursor?: string | null;
}

/** Wire shape returned by the approve and reject routes. */
export interface ApprovalDecisionWireResponse {
  approval: ApprovalWire;
}

/**
 * Maps one server ApprovalView to the client ApprovalItem.
 * - toolName      <- action
 * - serverName    <- (no server field exists) ""
 * - arguments     <- params
 * - policyReason  <- decisionReason
 * - requestedBy   <- requestedBy (null becomes "" to satisfy the string type)
 * Other fields pass through unchanged.
 */
export function mapApprovalWire(wire: ApprovalWire): ApprovalItem {
  return {
    id: wire.id,
    toolName: wire.action,
    serverName: "",
    arguments: wire.params ?? null,
    status: wire.status,
    requestedBy: wire.requestedBy ?? "",
    createdAt: wire.createdAt,
    expiresAt: wire.expiresAt,
    policyReason: wire.decisionReason,
  };
}

/** Shape the approvals page consumes after normalization. */
export interface ApprovalListResponse {
  items: ApprovalItem[];
  nextCursor: string | null;
}

export interface ListApprovalsParams {
  status?: ApprovalStatus;
  limit?: number;
  cursor?: string;
}

/** Query key root. Use approvalsQueryKeys for every query so invalidation stays consistent. */
export const approvalsQueryKeys = {
  all: ["approvals"] as const,
  list: (status: ApprovalStatus) => ["approvals", "list", status] as const,
};

export async function listApprovals(
  params: ListApprovalsParams = {},
): Promise<ApprovalListResponse> {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  const qs = search.toString();
  const res = await apiRequest("GET", `/api/approvals${qs ? `?${qs}` : ""}`);
  const wire = (await res.json()) as Partial<ApprovalListWireResponse>;
  return {
    items: Array.isArray(wire.approvals) ? wire.approvals.map(mapApprovalWire) : [],
    nextCursor: wire.nextCursor ?? null,
  };
}

export async function approveApproval(
  id: string,
  reason?: string,
): Promise<ApprovalItem> {
  const body = reason && reason.trim() ? { reason: reason.trim() } : {};
  const res = await apiRequest(
    "POST",
    `/api/approvals/${encodeURIComponent(id)}/approve`,
    body,
  );
  const data = (await res.json()) as ApprovalDecisionWireResponse;
  return mapApprovalWire(data.approval);
}

export async function rejectApproval(
  id: string,
  reason: string,
): Promise<ApprovalItem> {
  const res = await apiRequest(
    "POST",
    `/api/approvals/${encodeURIComponent(id)}/reject`,
    { reason: reason.trim() },
  );
  const data = (await res.json()) as ApprovalDecisionWireResponse;
  return mapApprovalWire(data.approval);
}
