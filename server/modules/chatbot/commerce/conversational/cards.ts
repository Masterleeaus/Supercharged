/**
 * Card builders. Each turns a result into a structured card plus plain fallback text.
 * Port of the card shapes in ConversationalCommerceRuntime.php, CustomerCommunicationCardRuntime.php and
 * MarketplaceCardRuntime.php. Every builder drops rows whose companyId differs from the one requested, so a
 * card can only show the caller's own products, carts and orders.
 */
import type { PublicApprovalAction } from "./approval-gate.ts";

export interface ProductView {
  id: number;
  companyId: string;
  name: string;
  priceMinor: number;
  currency: string;
  shortDescription: string | null;
  active: boolean;
  variants: { id: number; name: string; priceMinor: number; currency: string; inStock: boolean }[];
}

export interface CartCardView {
  companyId: string;
  id: string;
  currency: string | null;
  totalMinor: number;
  lines: { variantId: number; name: string; quantity: number; unitPriceMinor: number }[];
}

function money(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

/** Product list card. Inactive products and other companies' products are removed. */
export function productCards(companyId: string, products: readonly ProductView[]): { schema: Record<string, unknown>; fallback_text: string } {
  const own = products.filter((p) => p.companyId === companyId && p.active);
  const items = own.map((p) => ({
    id: p.id,
    name: p.name,
    price_minor: p.priceMinor,
    currency: p.currency,
    short_description: p.shortDescription,
    variants: p.variants.map((v) => ({ id: v.id, name: v.name, price_minor: v.priceMinor, currency: v.currency, in_stock: v.inStock })),
  }));
  const fallback = own.length === 0
    ? "No matching products were found."
    : own.map((p, i) => `${i + 1}. ${p.name} - ${money(p.priceMinor, p.currency)}`).join("\n");
  return { schema: { type: "commerce.product_list", version: 1, products: items }, fallback_text: fallback };
}

export function cartCard(cart: CartCardView, companyId: string): { schema: Record<string, unknown>; fallback_text: string } | null {
  if (cart.companyId !== companyId) return null;
  const currency = cart.currency ?? "";
  const lines = cart.lines.map((l) => ({ variant_id: l.variantId, name: l.name, quantity: l.quantity, unit_price_minor: l.unitPriceMinor }));
  return {
    schema: { type: "commerce.cart", version: 1, cart_id: cart.id, total_minor: cart.totalMinor, currency, lines },
    fallback_text: `Cart total: ${money(cart.totalMinor, currency || "AUD")}`,
  };
}

/**
 * Approval card. Carries the action type and amount only. The token is returned beside the card, never inside it,
 * and the token hash is never returned.
 */
export function approvalCard(action: PublicApprovalAction, message: string): { schema: Record<string, unknown>; fallback_text: string } {
  return {
    schema: {
      type: "commerce.approval",
      version: 1,
      action_id: action.id,
      action_type: action.actionType,
      status: action.status,
      amount_minor: action.amountMinor,
      currency: action.currency,
      expires_at: action.expiresAt.toISOString(),
      message,
    },
    fallback_text: `${message}. Confirm to continue.`,
  };
}

export interface ReplyDraftView {
  threadId: string;
  channel: string;
  intent: string;
  authorityLevel: string;
  text: string;
  actions: Record<string, unknown>[];
}

export function communicationReplyCard(draft: ReplyDraftView): { schema: Record<string, unknown>; fallback_text: string } {
  return {
    schema: {
      type: "commerce.customer_communication_reply",
      version: 1,
      thread_id: draft.threadId,
      channel: draft.channel,
      intent: draft.intent,
      authority_level: draft.authorityLevel,
      text: draft.text,
      actions: draft.actions,
    },
    fallback_text: draft.text,
  };
}

export interface EscalationView {
  id: string;
  companyId: string;
  reason: string;
  severity: string;
  status: string;
  summary: string;
  recommendedAction: string | null;
}

export function escalationCard(esc: EscalationView, companyId: string): { schema: Record<string, unknown>; fallback_text: string } | null {
  if (esc.companyId !== companyId) return null;
  return {
    schema: {
      type: "commerce.customer_communication_handoff",
      version: 1,
      escalation_id: esc.id,
      reason: esc.reason,
      severity: esc.severity,
      status: esc.status,
      summary: esc.summary,
      recommended_action: esc.recommendedAction,
    },
    fallback_text: `Conversation escalated (${esc.severity}). ${esc.summary}`,
  };
}
