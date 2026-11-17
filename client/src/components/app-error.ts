/**
 * Error shape the admin and app screens read from failed API calls.
 * Built by ApiError (client/src/lib/queryClient.ts) and by the handlers that
 * rethrow server errors. Fields are optional because plain Error objects
 * (network failures, errors from other layers) do not carry them.
 */

/** JSON body the server sends with an error response. */
export interface AppErrorBody {
  message?: string;
  error?: string;
  conflictType?: AppErrorConflictType;
  connectedAgentName?: string;
  campaignName?: string;
  campaignStatus?: string;
  suggestion?: string;
  [key: string]: unknown;
}

/** Conflict kinds the phone conflict dialog understands. */
export type AppErrorConflictType = "incoming_connection" | "active_campaign";

export interface AppError extends Error {
  status?: number;
  data?: AppErrorBody;
  error?: string;
  response?: { status?: number; data?: AppErrorBody };
  conflictType?: AppErrorConflictType;
  connectedAgentName?: string;
  campaignName?: string;
  campaignStatus?: string;
  suggestion?: string;
  hasPlivoNumbers?: boolean;
  userCount?: number;
}
