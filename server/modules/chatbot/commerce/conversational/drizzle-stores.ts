/**
 * Drizzle adapters for the conversational commerce ports. Every query filters on company_id first. A row from
 * another company is returned as absent. State changes use a compare-and-set UPDATE (status must still match),
 * so a repeated confirmation or a racing execution cannot both succeed.
 *
 * Tables: db/commerce-conversational.ts. Migration draft: db/migrations-draft/0002_commerce_conversational.sql.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  chatbotCommerceApprovalActions,
  chatbotCommerceCommMessages,
  chatbotCommerceCommPolicies,
  chatbotCommerceCommThreads,
  chatbotCommerceCredentials,
  chatbotCommerceEscalations,
  chatbotCommerceListingProposals,
  chatbotCommerceListingRules,
  chatbotCommerceShoppingSessions,
} from "../../db/commerce-conversational.ts";
import type { StoredSealed } from "../../secrets/sealed-form.ts";
import { CommerceError } from "./errors.ts";
import type { ApprovalAction, ApprovalActionStore, ApprovalScope, ApprovalStatus } from "./approval-gate.ts";
import type { CredentialRecord, CredentialRecordStore, CredentialProvider } from "./credentials.ts";
import type { CommEscalation, CommMessage, CommPolicy, CommThread, CommunicationStore } from "./communications.ts";
import type { ComplianceRule, ListingProposal, ListingProvider, ListingStore } from "./listing-intelligence.ts";
import type { ShoppingSessionState, ShoppingSessionStore } from "./conversational-runtime.ts";

export type CommerceDb = NodePgDatabase<Record<string, never>>;

const UNIQUE_VIOLATION = "23505";

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null ? ((cause as { code?: string }).code) : undefined;
}

function mapWriteError(error: unknown): never {
  if (pgCode(error) === UNIQUE_VIOLATION) {
    throw new CommerceError("conflict", "A record with the same key already exists.");
  }
  throw error;
}

const toBps = (v: number | null): number | null => (v === null ? null : Math.round(v * 10000));
const fromBps = (v: number | null): number | null => (v === null ? null : v / 10000);

// ---------------------------------------------------------------------------
// Approval actions
// ---------------------------------------------------------------------------

type ActionRow = typeof chatbotCommerceApprovalActions.$inferSelect;

function actionFromRow(row: ActionRow): ApprovalAction {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    scope: row.scope as ApprovalScope,
    subjectId: row.subjectId,
    actionType: row.actionType,
    status: row.status as ApprovalStatus,
    authorityLevel: row.authorityLevel as ApprovalAction["authorityLevel"],
    amountMinor: row.amountMinor,
    currency: row.currency,
    idempotencyKey: row.idempotencyKey,
    approvalTokenHash: row.approvalTokenHash,
    approvedBy: row.approvedBy,
    executedBy: row.executedBy,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    result: (row.result ?? null) as Record<string, unknown> | null,
    failureReason: row.failureReason,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleApprovalActionStore(db: CommerceDb): ApprovalActionStore {
  const t = chatbotCommerceApprovalActions;
  return {
    async findById(companyId, id) {
      const rows = await db.select().from(t).where(and(eq(t.companyId, companyId), eq(t.id, id))).limit(1);
      return rows[0] ? actionFromRow(rows[0]) : null;
    },
    async findByIdempotencyKey(companyId, chatbotId, scope, key) {
      const rows = await db.select().from(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId), eq(t.scope, scope), eq(t.idempotencyKey, key)))
        .limit(1);
      return rows[0] ? actionFromRow(rows[0]) : null;
    },
    async insert(action) {
      try {
        await db.insert(t).values({
          companyId: action.companyId,
          id: action.id,
          chatbotId: action.chatbotId,
          scope: action.scope,
          subjectId: action.subjectId,
          actionType: action.actionType,
          status: action.status,
          authorityLevel: action.authorityLevel,
          amountMinor: action.amountMinor,
          currency: action.currency,
          idempotencyKey: action.idempotencyKey,
          approvalTokenHash: action.approvalTokenHash,
          approvedBy: action.approvedBy,
          executedBy: action.executedBy,
          payload: action.payload,
          result: action.result,
          failureReason: action.failureReason,
          expiresAt: action.expiresAt,
          createdAt: action.createdAt,
          updatedAt: action.updatedAt,
        });
      } catch (error) {
        mapWriteError(error);
      }
    },
    async transition(companyId, id, from, patch) {
      const set: Partial<ActionRow> = { updatedAt: patch.updatedAt ?? new Date() };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.approvedBy !== undefined) set.approvedBy = patch.approvedBy;
      if (patch.executedBy !== undefined) set.executedBy = patch.executedBy;
      if (patch.result !== undefined) set.result = patch.result;
      if (patch.failureReason !== undefined) set.failureReason = patch.failureReason;
      const updated = await db.update(t).set(set)
        .where(and(eq(t.companyId, companyId), eq(t.id, id), inArray(t.status, [...from])))
        .returning({ id: t.id });
      return updated.length > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

type CredentialRow = typeof chatbotCommerceCredentials.$inferSelect;

function credentialFromRow(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    ownerUserId: row.ownerUserId,
    provider: row.provider as CredentialProvider,
    sealed: (row.sealed ?? null) as StoredSealed | null,
    configuration: (row.configuration ?? {}) as CredentialRecord["configuration"],
    fingerprint: row.fingerprint,
    status: row.status as "active" | "revoked",
    version: row.version,
    lastTestSucceeded: row.lastTestSucceeded,
    lastTestedAt: row.lastTestedAt,
    rotatedAt: row.rotatedAt,
    revokedAt: row.revokedAt,
  };
}

export function createDrizzleCredentialRecordStore(db: CommerceDb): CredentialRecordStore {
  const t = chatbotCommerceCredentials;
  return {
    async findById(companyId, id) {
      const rows = await db.select().from(t).where(and(eq(t.companyId, companyId), eq(t.id, id))).limit(1);
      return rows[0] ? credentialFromRow(rows[0]) : null;
    },
    async findByProvider(companyId, chatbotId, provider) {
      const rows = await db.select().from(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId), eq(t.provider, provider)))
        .limit(1);
      return rows[0] ? credentialFromRow(rows[0]) : null;
    },
    async save(record) {
      const values = {
        companyId: record.companyId,
        id: record.id,
        chatbotId: record.chatbotId,
        ownerUserId: record.ownerUserId,
        provider: record.provider,
        sealed: record.sealed,
        configuration: record.configuration,
        fingerprint: record.fingerprint,
        status: record.status,
        version: record.version,
        lastTestSucceeded: record.lastTestSucceeded,
        lastTestedAt: record.lastTestedAt,
        rotatedAt: record.rotatedAt,
        revokedAt: record.revokedAt,
        updatedAt: new Date(),
      };
      try {
        await db.insert(t).values(values).onConflictDoUpdate({
          target: [t.companyId, t.id],
          set: {
            sealed: values.sealed,
            configuration: values.configuration,
            fingerprint: values.fingerprint,
            status: values.status,
            version: values.version,
            lastTestSucceeded: values.lastTestSucceeded,
            lastTestedAt: values.lastTestedAt,
            rotatedAt: values.rotatedAt,
            revokedAt: values.revokedAt,
            updatedAt: values.updatedAt,
          },
          // The upsert never moves a row to another company: the target includes company_id.
        });
      } catch (error) {
        mapWriteError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Customer communications
// ---------------------------------------------------------------------------

type ThreadRow = typeof chatbotCommerceCommThreads.$inferSelect;
type MessageRow = typeof chatbotCommerceCommMessages.$inferSelect;

function threadFromRow(row: ThreadRow): CommThread {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    channel: row.channel,
    externalThreadId: row.externalThreadId,
    customerId: row.customerId,
    sessionId: row.sessionId,
    identityVerified: row.identityVerified,
    intent: row.intent,
    confidence: fromBps(row.confidenceBps),
    priority: row.priority as CommThread["priority"],
    sentiment: row.sentiment as CommThread["sentiment"],
    status: row.status as CommThread["status"],
    lastMessageAt: row.lastMessageAt,
  };
}

function messageFromRow(row: MessageRow): CommMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    threadId: row.threadId,
    chatbotId: row.chatbotId,
    channel: row.channel,
    externalMessageId: row.externalMessageId,
    direction: row.direction as CommMessage["direction"],
    actorType: row.actorType,
    body: row.body,
    intent: row.intent,
    confidence: fromBps(row.confidenceBps),
    receivedAt: row.receivedAt,
  };
}

export function createDrizzleCommunicationStore(db: CommerceDb): CommunicationStore {
  const th = chatbotCommerceCommThreads;
  const msg = chatbotCommerceCommMessages;
  const pol = chatbotCommerceCommPolicies;
  const esc = chatbotCommerceEscalations;

  const threadValues = (thread: CommThread) => ({
    companyId: thread.companyId,
    id: thread.id,
    chatbotId: thread.chatbotId,
    channel: thread.channel,
    externalThreadId: thread.externalThreadId,
    customerId: thread.customerId,
    sessionId: thread.sessionId,
    identityVerified: thread.identityVerified,
    intent: thread.intent,
    confidenceBps: toBps(thread.confidence),
    priority: thread.priority,
    sentiment: thread.sentiment,
    status: thread.status,
    lastMessageAt: thread.lastMessageAt,
    updatedAt: new Date(),
  });

  return {
    async findMessageByExternalId(companyId, chatbotId, channel, externalId) {
      const rows = await db.select().from(msg)
        .where(and(eq(msg.companyId, companyId), eq(msg.chatbotId, chatbotId), eq(msg.channel, channel), eq(msg.externalMessageId, externalId)))
        .limit(1);
      return rows[0] ? messageFromRow(rows[0]) : null;
    },
    async findThreadByExternalId(companyId, chatbotId, channel, externalThreadId) {
      const rows = await db.select().from(th)
        .where(and(eq(th.companyId, companyId), eq(th.chatbotId, chatbotId), eq(th.channel, channel), eq(th.externalThreadId, externalThreadId)))
        .limit(1);
      return rows[0] ? threadFromRow(rows[0]) : null;
    },
    async findThread(companyId, threadId) {
      const rows = await db.select().from(th).where(and(eq(th.companyId, companyId), eq(th.id, threadId))).limit(1);
      return rows[0] ? threadFromRow(rows[0]) : null;
    },
    async saveThread(thread) {
      await db.update(th).set(threadValues(thread)).where(and(eq(th.companyId, thread.companyId), eq(th.id, thread.id)));
    },
    async insertThread(thread) {
      try {
        await db.insert(th).values({ ...threadValues(thread), createdAt: new Date() });
      } catch (error) {
        mapWriteError(error);
      }
    },
    async insertMessage(message) {
      try {
        await db.insert(msg).values({
          companyId: message.companyId,
          id: message.id,
          threadId: message.threadId,
          chatbotId: message.chatbotId,
          channel: message.channel,
          externalMessageId: message.externalMessageId,
          direction: message.direction,
          actorType: message.actorType,
          body: message.body,
          intent: message.intent,
          confidenceBps: toBps(message.confidence),
          receivedAt: message.receivedAt,
        });
      } catch (error) {
        mapWriteError(error);
      }
    },
    async findMessage(companyId, messageId) {
      const rows = await db.select().from(msg).where(and(eq(msg.companyId, companyId), eq(msg.id, messageId))).limit(1);
      return rows[0] ? messageFromRow(rows[0]) : null;
    },
    async latestInbound(companyId, threadId) {
      const rows = await db.select().from(msg)
        .where(and(eq(msg.companyId, companyId), eq(msg.threadId, threadId), eq(msg.direction, "inbound")))
        .orderBy(desc(msg.receivedAt))
        .limit(1);
      return rows[0] ? messageFromRow(rows[0]) : null;
    },
    async getPolicy(companyId, chatbotId) {
      const rows = await db.select().from(pol).where(and(eq(pol.companyId, companyId), eq(pol.chatbotId, chatbotId))).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        companyId: row.companyId,
        chatbotId: row.chatbotId,
        autoReplyEnabled: row.autoReplyEnabled,
        autoReplyConfidence: row.autoReplyConfidenceBps / 10000,
        limits: {
          automatic_refund_limit: row.automaticRefundLimitMinor,
          automatic_discount_limit: row.automaticDiscountLimitMinor,
          automatic_store_credit_limit: row.automaticStoreCreditLimitMinor,
          automatic_replacement_limit: row.automaticReplacementLimitMinor,
          automatic_cancellation_limit: row.automaticCancellationLimitMinor,
        },
        currency: row.currency,
        active: row.active,
      } satisfies CommPolicy;
    },
    async insertEscalation(escalation: CommEscalation) {
      try {
        await db.insert(esc).values({
          companyId: escalation.companyId,
          id: escalation.id,
          threadId: escalation.threadId,
          chatbotId: escalation.chatbotId,
          reason: escalation.reason,
          severity: escalation.severity,
          status: escalation.status,
          summary: escalation.summary,
          recommendedAction: escalation.recommendedAction,
          contextSnapshot: escalation.contextSnapshot,
        });
      } catch (error) {
        mapWriteError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Listing intelligence (output only)
// ---------------------------------------------------------------------------

export function createDrizzleListingStore(db: CommerceDb): ListingStore {
  const rules = chatbotCommerceListingRules;
  const proposals = chatbotCommerceListingProposals;
  return {
    async rules(companyId, chatbotId, provider: ListingProvider) {
      const rows = await db.select().from(rules)
        .where(and(eq(rules.companyId, companyId), eq(rules.active, true), inArray(rules.provider, ["generic", provider])))
        .orderBy(asc(rules.priority));
      return rows
        .filter((r) => r.chatbotId === null || r.chatbotId === chatbotId)
        .map((r): ComplianceRule => ({
          code: r.code,
          severity: r.severity as ComplianceRule["severity"],
          terms: (r.terms ?? []) as string[],
          fieldScopes: (r.fieldScopes ?? []) as string[],
          message: r.message,
          remediation: r.remediation,
        }));
    },
    async saveProposal(p: ListingProposal) {
      // Output only. The status column only accepts "ready" or "blocked".
      try {
        await db.insert(proposals).values({
          companyId: p.companyId,
          id: p.id,
          chatbotId: p.chatbotId,
          provider: p.provider,
          productId: p.productId,
          sourceHash: p.sourceHash,
          status: p.status,
          proposedContent: p.proposedContent,
          findings: p.findings,
          proposalHash: p.proposalHash,
          createdAt: p.createdAt,
        });
      } catch (error) {
        mapWriteError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shopping session state
// ---------------------------------------------------------------------------

export function createDrizzleShoppingSessionStore(db: CommerceDb): ShoppingSessionStore {
  const t = chatbotCommerceShoppingSessions;
  return {
    async load(companyId, chatbotId, sessionId) {
      const rows = await db.select().from(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId), eq(t.sessionId, sessionId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        companyId: row.companyId,
        chatbotId: row.chatbotId,
        sessionId: row.sessionId,
        currentProductIds: (row.currentProductIds ?? []) as number[],
        selectedProductId: row.selectedProductId,
        selectedVariantId: row.selectedVariantId,
        lastQuery: row.lastQuery,
        customerId: row.customerId,
        contextVersion: row.contextVersion,
      } satisfies ShoppingSessionState;
    },
    async save(state) {
      const values = {
        companyId: state.companyId,
        chatbotId: state.chatbotId,
        sessionId: state.sessionId,
        customerId: state.customerId,
        currentProductIds: state.currentProductIds,
        selectedProductId: state.selectedProductId,
        selectedVariantId: state.selectedVariantId,
        lastQuery: state.lastQuery,
        contextVersion: state.contextVersion,
        updatedAt: new Date(),
      };
      await db.insert(t).values(values).onConflictDoUpdate({
        target: [t.companyId, t.chatbotId, t.sessionId],
        set: {
          customerId: values.customerId,
          currentProductIds: values.currentProductIds,
          selectedProductId: values.selectedProductId,
          selectedVariantId: values.selectedVariantId,
          lastQuery: values.lastQuery,
          contextVersion: values.contextVersion,
          updatedAt: values.updatedAt,
        },
      });
    },
  };
}
