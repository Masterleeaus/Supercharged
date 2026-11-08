/**
 * Shared error type and company-scope guard for the chatbot module.
 *
 * Every storage and service call takes companyId as its first argument. requireCompanyId() runs
 * at both layers, so a missing or malformed tenant fails closed even when a caller skips the route.
 */

import { isCompanyId } from "../../infrastructure/database/tenant-context.ts";

export class ChatbotError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ChatbotError";
    this.status = status;
  }
}

/** Returns the company id, or throws a 403 when it is absent or not a UUID. */
export function requireCompanyId(companyId: unknown): string {
  if (!isCompanyId(companyId)) {
    throw new ChatbotError("Company scope required", 403);
  }
  return companyId;
}
