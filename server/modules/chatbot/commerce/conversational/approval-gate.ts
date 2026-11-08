/**
 * Approval gate shared by shopping and customer-communication actions.
 *
 * Lifecycle: awaiting_approval -> approved -> executed | failed, or awaiting_approval -> expired.
 * Actions that need no customer or staff confirmation (authority "execute_within_limits") start at "ready".
 *
 * Rules:
 * - proposeAction() never runs anything. It stores the action and returns a one-time token. Only the SHA-256 of
 *   the token is stored.
 * - claimForExecution() is the only way into execution. It checks expiry, the approver's authority, and the token,
 *   then moves the row with a compare-and-set, so two confirmations cannot both run.
 * - A replay of an executed action returns the stored result and does not run again.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CommerceError } from "./errors.ts";
import { assertCanApprove, type ApproverActor, type AuthorityLevel } from "./authority.ts";

export const APPROVAL_STATUSES = ["awaiting_approval", "ready", "approved", "executed", "failed", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type ApprovalScope = "conversational" | "communication";

export interface ApprovalAction {
  id: string;
  companyId: string;
  chatbotId: string;
  scope: ApprovalScope;
  /** Shopping session id, or communication thread id. */
  subjectId: string;
  actionType: string;
  status: ApprovalStatus;
  authorityLevel: AuthorityLevel;
  amountMinor: number | null;
  currency: string | null;
  idempotencyKey: string;
  approvalTokenHash: string | null;
  approvedBy: string | null;
  executedBy: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  failureReason: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Storage port. Every method takes companyId, and a row from another company is reported as absent. */
export interface ApprovalActionStore {
  findById(companyId: string, id: string): Promise<ApprovalAction | null>;
  findByIdempotencyKey(companyId: string, chatbotId: string, scope: ApprovalScope, key: string): Promise<ApprovalAction | null>;
  insert(action: ApprovalAction): Promise<void>;
  /** Writes patch only when the current status is one of `from`. Returns false when nothing matched. */
  transition(companyId: string, id: string, from: readonly ApprovalStatus[], patch: Partial<ApprovalAction>): Promise<boolean>;
}

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newApprovalToken(): string {
  return randomBytes(32).toString("hex");
}

/** Action as returned to callers. The token hash is never included. */
export type PublicApprovalAction = Omit<ApprovalAction, "approvalTokenHash">;

export function publicAction(action: ApprovalAction): PublicApprovalAction {
  const { approvalTokenHash: _hash, ...rest } = action;
  return rest;
}

export interface ProposeInput {
  companyId: string;
  chatbotId: string;
  scope: ApprovalScope;
  subjectId: string;
  actionType: string;
  authorityLevel: AuthorityLevel;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  amountMinor?: number | null;
  currency?: string | null;
  ttlMinutes: number;
}

export interface ProposeResult {
  action: PublicApprovalAction;
  /** Shown once, to the party that must confirm. Null for "ready" actions and idempotent replays. */
  approvalToken: string | null;
  replay: boolean;
}

export async function proposeAction(store: ApprovalActionStore, now: Date, input: ProposeInput, newId: () => string): Promise<ProposeResult> {
  if (input.idempotencyKey.trim() === "") throw new CommerceError("validation", "An idempotency key is required.", { idempotency_key: "required" });
  const existing = await store.findByIdempotencyKey(input.companyId, input.chatbotId, input.scope, input.idempotencyKey);
  if (existing) return { action: publicAction(existing), approvalToken: null, replay: true };

  const needsConfirmation = input.authorityLevel !== "execute_within_limits";
  const token = needsConfirmation ? newApprovalToken() : null;
  const action: ApprovalAction = {
    id: newId(),
    companyId: input.companyId,
    chatbotId: input.chatbotId,
    scope: input.scope,
    subjectId: input.subjectId,
    actionType: input.actionType,
    status: needsConfirmation ? "awaiting_approval" : "ready",
    authorityLevel: input.authorityLevel,
    amountMinor: input.amountMinor ?? null,
    currency: input.currency ? input.currency.toUpperCase() : null,
    idempotencyKey: input.idempotencyKey,
    approvalTokenHash: token ? hashApprovalToken(token) : null,
    approvedBy: null,
    executedBy: null,
    payload: input.payload,
    result: null,
    failureReason: null,
    expiresAt: new Date(now.getTime() + input.ttlMinutes * 60_000),
    createdAt: now,
    updatedAt: now,
  };
  await store.insert(action);
  return { action: publicAction(action), approvalToken: token, replay: false };
}

export type ClaimOutcome =
  | { state: "claimed"; action: ApprovalAction }
  | { state: "replay"; action: ApprovalAction };

/**
 * Checks the approver and the token, then moves the action to "approved" so exactly one caller can execute it.
 * Refusals leave the row unchanged, except an expired action, which is marked expired.
 */
export async function claimForExecution(
  store: ApprovalActionStore,
  now: Date,
  companyId: string,
  actionId: string,
  token: string | null,
  approver: ApproverActor,
  approverId: string,
): Promise<ClaimOutcome> {
  const action = await store.findById(companyId, actionId);
  if (action === null) throw new CommerceError("not_found", "The action was not found.");
  if (action.status === "executed") return { state: "replay", action };

  assertCanApprove(approver, action.actionType);

  if (action.expiresAt.getTime() <= now.getTime() && (action.status === "awaiting_approval" || action.status === "ready")) {
    await store.transition(companyId, actionId, ["awaiting_approval", "ready"], { status: "expired", updatedAt: now });
    throw new CommerceError("expired", "The action has expired. Ask again to prepare it.");
  }

  if (action.status === "awaiting_approval") {
    if (token === null || action.approvalTokenHash === null || !tokenMatches(token, action.approvalTokenHash)) {
      throw new CommerceError("invalid_token", "The approval token is invalid.", { approval_token: "invalid" });
    }
    const moved = await store.transition(companyId, actionId, ["awaiting_approval"], {
      status: "approved",
      approvedBy: approverId,
      updatedAt: now,
    });
    if (!moved) throw new CommerceError("conflict", "The action changed while it was being confirmed. Try again.");
  } else if (action.status === "ready") {
    const moved = await store.transition(companyId, actionId, ["ready"], { status: "approved", approvedBy: approverId, updatedAt: now });
    if (!moved) throw new CommerceError("conflict", "The action changed while it was being confirmed. Try again.");
  } else {
    throw new CommerceError("conflict", "The action cannot be executed from its current state.");
  }

  const current = await store.findById(companyId, actionId);
  if (current === null) throw new CommerceError("not_found", "The action was not found.");
  return { state: "claimed", action: current };
}

export async function completeAction(store: ApprovalActionStore, now: Date, companyId: string, actionId: string, executedBy: string, result: Record<string, unknown>): Promise<boolean> {
  return store.transition(companyId, actionId, ["approved"], { status: "executed", executedBy, result, failureReason: null, updatedAt: now });
}

export async function failAction(store: ApprovalActionStore, now: Date, companyId: string, actionId: string, reason: string): Promise<boolean> {
  return store.transition(companyId, actionId, ["approved"], { status: "failed", failureReason: reason.slice(0, 500), updatedAt: now });
}

function tokenMatches(token: string, storedHash: string): boolean {
  const given = Buffer.from(hashApprovalToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
