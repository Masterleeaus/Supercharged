/**
 * Typed insert-row helpers for the flow-automation routes.
 *
 * Zod-validated request data does not line up exactly with the Drizzle insert types: optional
 * and defaulted columns differ, and jsonb columns carry $type generics the Zod output does not
 * reproduce. These helpers take the merged field object and return it typed as the table's
 * insert row. Each helper returns its input unchanged, so the values written to the database
 * are the same as before.
 */
import { flows, webhooks } from "@shared/schema";

export type FlowInsertRow = typeof flows.$inferInsert;
export type WebhookInsertRow = typeof webhooks.$inferInsert;

/** Builds a flows insert row from validated fields plus server-owned keys (id, userId, companyId). */
export function flowInsertRow(fields: Record<string, unknown>): FlowInsertRow {
  return fields as FlowInsertRow;
}

/** Builds a webhook_subscriptions insert row from validated fields plus server-owned keys. */
export function webhookInsertRow(fields: Record<string, unknown>): WebhookInsertRow {
  return fields as WebhookInsertRow;
}
