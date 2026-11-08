/*
 * Always-approval list: tool IDs that need a verified owner approval on every call, whatever
 * the role, risk tier or autonomy. This is the code form of the owner rule for the money,
 * customer_send and delete categories (see policy-evaluator.ts CATEGORIES and company-policy.ts
 * OWNER_APPROVAL_RULES).
 *
 * Pure. No database, network or environment access.
 *
 * Grouping (each tool ID appears once):
 *  - money:          moves money or makes a money decision (refunds, payment plans).
 *  - customer_send:  sends or asks a customer for something through a message.
 *  - delete:         deletes or merges a record.
 *
 * Read-only tools that share a name pattern with these (for example payments.list and
 * refund_requests.list) are not listed. Draft tools (customer_messages.draft, messages.draft_customer)
 * are not listed either: they produce text for a person to review and send nothing.
 * purchase_orders.draft is the one listed draft: a purchase is money out, so the draft is gated.
 */

export type AlwaysApprovalCategory = 'money' | 'customer_send' | 'delete';

/** The list, grouped by category. The flat list below is derived from this, so the two cannot drift. */
export const ALWAYS_APPROVAL_BY_CATEGORY: Readonly<Record<AlwaysApprovalCategory, readonly string[]>> = Object.freeze({
  money: Object.freeze([
    'payment_plans.propose',
    'purchase_orders.draft',
    'refund_requests.create',
    'refund_requests.prepare',
  ]),
  customer_send: Object.freeze([
    'compliance_reminders.send',
    'customer_messages.send',
    'feedback_surveys.send',
    'job_photos.request_from_customer',
    'job_signoff.request',
    'messages.send',
    'messages.send_customer',
    'reviews.request',
  ]),
  delete: Object.freeze(['client_merge_suggestions.create']),
});

export const ALWAYS_APPROVAL_ACTIONS: readonly string[] = Object.freeze([
  ...ALWAYS_APPROVAL_BY_CATEGORY.money,
  ...ALWAYS_APPROVAL_BY_CATEGORY.customer_send,
  ...ALWAYS_APPROVAL_BY_CATEGORY.delete,
]);

const ALWAYS_APPROVAL_CATEGORY_MAP: ReadonlyMap<string, AlwaysApprovalCategory> = new Map(
  (Object.keys(ALWAYS_APPROVAL_BY_CATEGORY) as AlwaysApprovalCategory[]).flatMap((category) =>
    ALWAYS_APPROVAL_BY_CATEGORY[category].map((toolId) => [toolId, category] as const),
  ),
);

/*
 * Fail-closed name fallback for tools that are not yet on the list (a new role, or a tool added
 * later). Read verbs are never matched, so list, get and similar tools stay ungated.
 *  - money: money in or out by verb (payment, payout, transfer, refund, deposit, charge, purchase order).
 *  - delete: a record is deleted, destroyed, purged, erased or removed.
 *  - customer_send: a message is sent to a customer (".send", ".send_customer", "request_from_customer").
 * Money is checked first, so a money verb always takes the money path.
 */
const READ_VERB_SUFFIX = /\.(list|get|read|search|view|check|status|lookup)$/;
const MONEY_NAME = /(^|[._])(payments?|payouts?|transfers?|refunds?|deposits?|charges?|purchase_orders?|disburse)([._]|$)/;
const DELETE_NAME = /(^|[._])(delete|destroy|purge|erase|remove)([._]|$)/;
const CUSTOMER_SEND_NAME = /\.send(_customer)?$|request_from_customer$/;

/** True when the tool ID is on the always-approval list, or matches a gated name. Non-string input returns false. */
export function isAlwaysApproval(toolId: unknown): boolean {
  return alwaysApprovalCategoryOf(toolId) !== null;
}

/**
 * The gated category of a tool, or null when the tool is not gated. A listed tool returns its list
 * category. An unlisted tool returns a category only when its name matches the fallback above and it
 * is not a read verb. The policy evaluator uses this so a gated tool stays gated even when its caller
 * passes no category.
 */
export function alwaysApprovalCategoryOf(toolId: unknown): AlwaysApprovalCategory | null {
  if (typeof toolId !== 'string') return null;
  const listed = ALWAYS_APPROVAL_CATEGORY_MAP.get(toolId);
  if (listed !== undefined) return listed;
  if (READ_VERB_SUFFIX.test(toolId)) return null;
  if (MONEY_NAME.test(toolId)) return 'money';
  if (DELETE_NAME.test(toolId)) return 'delete';
  if (CUSTOMER_SEND_NAME.test(toolId)) return 'customer_send';
  return null;
}
