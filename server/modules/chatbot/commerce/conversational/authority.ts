/**
 * Role routing, customer-communication authority, and staff approval rules.
 * Port of CommerceRoleRouter.php, CommerceRoleRuntime.php (assertAllowed), CustomerCommunicationAuthority.php,
 * and CommercePermissionMap.php. Pure functions: no storage, no clock, no network.
 */
import { CommerceError } from "./errors.ts";

export const COMMERCE_ROLES = ["shopping_assistant", "seller_steward", "customer_communications"] as const;
export type CommerceRoleName = (typeof COMMERCE_ROLES)[number];

const SUPPORT_INTENTS = [
  "order_status", "tracking", "delivery_delay", "return", "exchange", "refund_status", "damaged_item", "missing_item",
  "payment_problem", "checkout_problem", "warranty", "complaint", "product_support", "cancel_order", "address_correction",
  "human_support",
];
const SUPPORT_CHANNELS = ["email", "sms", "whatsapp", "telegram", "messenger", "instagram", "marketplace_message", "internal_inbox"];

export interface RoleContext {
  actorType: string;
  requestedRole: string;
  authenticated?: boolean;
  intent?: string;
  channel?: string;
  inboundSupport?: boolean;
}

/** Port of CommerceRoleRouter::resolve. A non-customer, non-seller actor always lands on the shopping role. */
export function resolveCommerceRole(context: RoleContext): CommerceRoleName {
  const actorType = context.actorType.trim().toLowerCase();
  const requested = context.requestedRole.trim().toLowerCase();
  const authenticated = context.authenticated === true;

  if (actorType === "seller" && authenticated) {
    return requested === "customer_communications" ? "customer_communications" : "seller_steward";
  }
  if (actorType !== "customer") return "shopping_assistant";
  if (requested === "customer_communications") return "customer_communications";

  const intent = (context.intent ?? "").trim().toLowerCase();
  const channel = (context.channel ?? "web").trim().toLowerCase();
  if (SUPPORT_INTENTS.includes(intent) || (context.inboundSupport === true && SUPPORT_CHANNELS.includes(channel))) {
    return "customer_communications";
  }
  return "shopping_assistant";
}

/** Port of CommerceRoleRuntime::assertAllowed. Refuses a requested role the actor does not resolve to. */
export function assertRoleAllowed(requested: string, context: Omit<RoleContext, "requestedRole">): void {
  if (!(COMMERCE_ROLES as readonly string[]).includes(requested)) {
    throw new CommerceError("validation", "The commerce role is invalid.", { role: "invalid" });
  }
  if (resolveCommerceRole({ ...context, requestedRole: requested }) !== requested) {
    throw new CommerceError("forbidden", "The actor is not permitted to use this commerce role.", { role: "forbidden" });
  }
}

// ---------------------------------------------------------------------------
// Customer communication authority
// ---------------------------------------------------------------------------

export type AuthorityLevel =
  | "answer_automatically"
  | "prepare_automatically"
  | "execute_within_limits"
  | "require_approval"
  | "human_only";

export interface AuthorityDecision {
  level: AuthorityLevel;
  allowed: boolean;
  escalate: boolean;
  reason: string;
}

export const AUTOMATIC_LIMIT_KEYS = {
  issue_refund: "automatic_refund_limit",
  offer_discount: "automatic_discount_limit",
  issue_store_credit: "automatic_store_credit_limit",
  replace_item: "automatic_replacement_limit",
  cancel_order: "automatic_cancellation_limit",
} as const;
export type AutomaticLimitKey = (typeof AUTOMATIC_LIMIT_KEYS)[keyof typeof AUTOMATIC_LIMIT_KEYS];

export interface AuthorityContext {
  confidence?: number;
  identityVerified?: boolean;
  /** Minor units. */
  amountMinor?: number;
  limits?: Partial<Record<AutomaticLimitKey, number>>;
}

const HUMAN_ONLY = ["legal_threat", "fraud_suspected", "chargeback_dispute", "safety_incident", "regulatory_complaint"];
const FACTUAL = ["answer_product_question", "explain_policy", "check_stock", "explain_bnpl"];
const RECORD_LOOKUPS = ["get_order_status", "get_tracking", "get_refund_status", "get_return_status", "get_payment_status"];
const PREPARE_ONLY = ["prepare_cart_recovery", "prepare_return", "prepare_exchange", "prepare_replacement", "prepare_address_correction"];
const FINANCIAL = ["issue_refund", "offer_discount", "issue_store_credit", "replace_item", "cancel_order"];

function result(level: AuthorityLevel, allowed: boolean, escalate: boolean, reason: string): AuthorityDecision {
  return { level, allowed, escalate, reason };
}

/** Port of CustomerCommunicationAuthority::decision. Unknown actions fail closed. */
export function communicationAuthority(action: string, context: AuthorityContext = {}): AuthorityDecision {
  const kind = action.trim().toLowerCase();
  const confidence = Math.max(0, Math.min(1, context.confidence ?? 0));
  const verified = context.identityVerified === true;

  if (HUMAN_ONLY.includes(kind)) return result("human_only", false, true, "This action requires a trained human decision-maker.");
  if (FACTUAL.includes(kind)) {
    return confidence >= 0.85
      ? result("answer_automatically", true, false, "High-confidence factual answer.")
      : result("prepare_automatically", false, false, "The answer should be reviewed because confidence is below the automatic threshold.");
  }
  if (RECORD_LOOKUPS.includes(kind)) {
    return verified && confidence >= 0.8
      ? result("answer_automatically", true, false, "Verified customer and factual commerce record.")
      : result("require_approval", false, !verified, "Customer identity or factual confidence is insufficient.");
  }
  if (PREPARE_ONLY.includes(kind)) {
    return result("prepare_automatically", true, false, "The action may be prepared but not committed without the required approval.");
  }
  if (FINANCIAL.includes(kind)) {
    const limitKey = AUTOMATIC_LIMIT_KEYS[kind as keyof typeof AUTOMATIC_LIMIT_KEYS];
    const amount = Math.max(0, Math.trunc(context.amountMinor ?? 0));
    const limit = Math.max(0, Math.trunc(context.limits?.[limitKey] ?? 0));
    if (verified && limit > 0 && amount > 0 && amount <= limit) {
      return result("execute_within_limits", true, false, "The action is inside an explicitly configured automatic limit.");
    }
    return result("require_approval", false, false, "The action creates a financial or fulfilment obligation and requires approval.");
  }
  if (kind === "correct_address") {
    return verified
      ? result("execute_within_limits", true, false, "Verified minor address correction.")
      : result("require_approval", false, true, "Identity verification is required before changing an address.");
  }
  if (kind === "handoff_to_human") return result("human_only", true, true, "The conversation was explicitly escalated.");
  return result("require_approval", false, false, "Unknown actions fail closed.");
}

// ---------------------------------------------------------------------------
// Who may approve what
// ---------------------------------------------------------------------------

/**
 * Staff permission needed to approve an action. Strings come from CommercePermissionMap.php.
 * Decision: the PHP only checked the approval token. This port also requires a staff permission for
 * money and order changes, so a staff member without it is refused even with a valid token.
 */
export const APPROVAL_PERMISSION: Readonly<Record<string, string>> = {
  issue_refund: "chatbot-ecommerce.manage-payments",
  cancel_order: "chatbot-ecommerce.manage-orders",
  correct_address: "chatbot-ecommerce.manage-orders",
  request_return: "chatbot-ecommerce.manage-orders",
  prepare_return: "chatbot-ecommerce.manage-orders",
  prepare_checkout: "chatbot-ecommerce.manage-checkout",
  add_to_cart: "chatbot-ecommerce.manage-checkout",
  apply_coupon: "chatbot-ecommerce.manage-pricing",
};

/** Actions a shopper may confirm for themselves with the approval token. Everything else needs staff. */
export const CUSTOMER_CONFIRMABLE: readonly string[] = ["add_to_cart", "apply_coupon", "prepare_checkout", "request_return"];

export type ApproverActor =
  | { type: "customer" }
  | { type: "staff"; role: CommerceRoleName; permissions: readonly string[] };

const STAFF_APPROVAL_ROLES: readonly CommerceRoleName[] = ["seller_steward", "customer_communications"];

/** Throws forbidden when the approver may not confirm this action type. Does not look at the token. */
export function assertCanApprove(actor: ApproverActor, actionType: string): void {
  if (actor.type === "customer") {
    if (!CUSTOMER_CONFIRMABLE.includes(actionType)) {
      throw new CommerceError("forbidden", "Only a staff member can approve this action.", { action: "forbidden" });
    }
    return;
  }
  if (!STAFF_APPROVAL_ROLES.includes(actor.role)) {
    throw new CommerceError("forbidden", "This commerce role cannot approve actions.", { role: "forbidden" });
  }
  const permission = APPROVAL_PERMISSION[actionType];
  if (permission === undefined || !actor.permissions.includes(permission)) {
    throw new CommerceError("forbidden", "The staff member lacks the permission to approve this action.", { action: "forbidden" });
  }
}
