/*
 * Drizzle inbox adapter. Writes go through the app pool and withTenant, as in
 * server/modules/approvals/index.ts, so every write runs on one company-scoped transaction.
 *
 * Two parts are live: the transaction runner for the approved-send path, and the store-level
 * inbound lock (a transaction-scoped advisory lock, so the lock holds across server instances).
 * Inbox tables were promoted at migrations/0010a_inbox.sql; the CRUD methods below stay
 * as compatibility placeholders until the optional SQL store is deployed. Nothing here imports drizzle-orm, and the pool
 * is loaded lazily, so the module loads without DATABASE_URL.
 */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertCompanyId, withTenant, type TenantPool, type TenantQueryClient } from '../../infrastructure/database/tenant-context.ts';
import type { InboxStore, InboxTransactionRunner, InboxWriteTx, MessagePatch, ThreadPatch } from './ports.ts';
import type { AssigneeKind, Channel, Message, MessageStatus, Thread, ThreadStatus } from './types.ts';

const NOT_READY =
  'inbox: Drizzle storage is not available. Promote migrations/DRAFT_inbox.sql and wire the tables before use.';

const notReady = async (..._args: unknown[]): Promise<never> => {
  throw new Error(NOT_READY);
};

/**
 * The client that holds the inbound advisory lock in the current async context. Store queries
 * made inside the critical section should use it. Otherwise they need a second pool connection
 * while the lock holds one, which can exhaust the pool under load.
 */
const inboundLockClient = new AsyncLocalStorage<TenantQueryClient>();

/** The connection holding the inbound lock in this async context, or undefined outside the lock. */
export function currentInboundLockClient(): TenantQueryClient | undefined {
  return inboundLockClient.getStore();
}

/**
 * Signed 64-bit key for pg_advisory_xact_lock, derived from (company, channel, address).
 * Hashed in JS so the key does not depend on the Postgres version. A collision only
 * serializes two unrelated contacts. It never lets two writers past the lock.
 */
export function inboundAdvisoryKey(companyId: string, channel: Channel, address: string): string {
  const digest = createHash('sha256').update(`inbox-inbound|${companyId}|${channel}|${address}`, 'utf8').digest();
  return digest.readBigInt64BE(0).toString();
}

type Row = Record<string, any>;

const THREAD_COLUMNS = 'id, company_id, channel, subject, status, assignee_kind, assignee_id, last_message_at, created_at, updated_at';
const MESSAGE_COLUMNS =
  'id, company_id, thread_id, direction, channel, status, author_kind, author_id, body, body_sha256, external_id, approval_id, created_at, updated_at, queued_at';

function rowToThread(row: Row): Thread {
  return {
    companyId: row.company_id,
    id: row.id,
    channel: row.channel,
    subject: row.subject ?? null,
    status: row.status as ThreadStatus,
    assignee: row.assignee_kind ? { kind: row.assignee_kind as AssigneeKind, id: row.assignee_id } : null,
    lastMessageAt: row.last_message_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: Row): Message {
  return {
    companyId: row.company_id,
    id: row.id,
    threadId: row.thread_id,
    direction: row.direction,
    channel: row.channel,
    status: row.status as MessageStatus,
    authorKind: row.author_kind,
    authorId: row.author_id ?? null,
    body: row.body,
    bodySha256: row.body_sha256,
    externalId: row.external_id ?? null,
    approvalId: row.approval_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    queuedAt: row.queued_at ?? null,
  };
}

/**
 * Write methods for one company, run on a client that already has the tenant set. Each write
 * is scoped by company_id. A method returns false or null when nothing applied.
 */
export function sqlInboxWriteTx(client: TenantQueryClient, boundCompanyId: string): InboxWriteTx {
  const assertBound = (companyId: string): void => {
    if (companyId !== boundCompanyId) throw new Error('inbox: transaction is bound to a different company');
  };

  return {
    async markApprovalExecuted(companyId, approvalId) {
      assertBound(companyId);
      const result = await client.query(
        `UPDATE approvals
            SET executed_at = now(), updated_at = now()
          WHERE company_id = $1 AND id = $2 AND status = 'approved' AND executed_at IS NULL
          RETURNING id`,
        [companyId, approvalId],
      );
      return result.rows.length === 1;
    },

    async updateThread(companyId: string, id: string, patch: ThreadPatch): Promise<Thread | null> {
      assertBound(companyId);
      const sets: string[] = [];
      const values: unknown[] = [companyId, id];
      // Column names come from this fixed list, never from input.
      const add = (column: string, value: unknown): void => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      if (patch.status !== undefined) add('status', patch.status);
      if (patch.assignee !== undefined) {
        add('assignee_kind', patch.assignee?.kind ?? null);
        add('assignee_id', patch.assignee?.id ?? null);
      }
      if (patch.lastMessageAt !== undefined) add('last_message_at', patch.lastMessageAt);
      if (patch.updatedAt !== undefined) add('updated_at', patch.updatedAt);

      if (sets.length === 0) {
        const found = await client.query(`SELECT ${THREAD_COLUMNS} FROM inbox_threads WHERE company_id = $1 AND id = $2`, [companyId, id]);
        return found.rows[0] ? rowToThread(found.rows[0]) : null;
      }
      const result = await client.query(
        `UPDATE inbox_threads SET ${sets.join(', ')} WHERE company_id = $1 AND id = $2 RETURNING ${THREAD_COLUMNS}`,
        values,
      );
      return result.rows[0] ? rowToThread(result.rows[0]) : null;
    },

    async updateMessage(companyId: string, id: string, patch: MessagePatch): Promise<Message | null> {
      assertBound(companyId);
      const sets: string[] = [];
      const values: unknown[] = [companyId, id];
      const add = (column: string, value: unknown): void => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      if (patch.status !== undefined) add('status', patch.status);
      if (patch.approvalId !== undefined) add('approval_id', patch.approvalId);
      if (patch.queuedAt !== undefined) add('queued_at', patch.queuedAt);
      if (patch.updatedAt !== undefined) add('updated_at', patch.updatedAt);

      if (sets.length === 0) {
        const found = await client.query(`SELECT ${MESSAGE_COLUMNS} FROM inbox_messages WHERE company_id = $1 AND id = $2`, [companyId, id]);
        return found.rows[0] ? rowToMessage(found.rows[0]) : null;
      }
      const result = await client.query(
        `UPDATE inbox_messages SET ${sets.join(', ')} WHERE company_id = $1 AND id = $2 RETURNING ${MESSAGE_COLUMNS}`,
        values,
      );
      return result.rows[0] ? rowToMessage(result.rows[0]) : null;
    },
  };
}

/**
 * Transaction runner for one company, backed by the app pool in server/db.ts. Each
 * runInTransaction opens one withTenant transaction, so the approval claim, the thread
 * touch and the message status commit together or not at all. The port carries no
 * companyId, so build one runner per company (as approvals does with poolTransactionsFor).
 */
export function createDrizzleTransactionRunner(companyId: string): InboxTransactionRunner {
  const tenant = assertCompanyId(companyId);
  return {
    async runInTransaction<T>(callback: (tx: InboxWriteTx) => Promise<T>): Promise<T> {
      const { pool } = await import('../../db.ts');
      return withTenant(pool as unknown as TenantPool, tenant, (client) => callback(sqlInboxWriteTx(client, tenant)));
    },
  };
}

export function createDrizzleInboxStore(): InboxStore {
  return {
    async lockInboundKey<T>(companyId: string, channel: Channel, address: string, fn: () => Promise<T>): Promise<T> {
      const tenant = assertCompanyId(companyId);
      const key = inboundAdvisoryKey(tenant, channel, address);
      const { pool } = await import('../../db.ts');
      // The lock is transaction-scoped: it is released on COMMIT or ROLLBACK, after fn has
      // finished. fn's own writes are autocommitted, so they are visible to the next holder.
      return withTenant(pool as unknown as TenantPool, tenant, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
        return inboundLockClient.run(client, fn);
      });
    },
    insertParticipant: notReady,
    findContactParticipant: notReady,
    insertThread: notReady,
    findThread: notReady,
    findOpenThreadForParticipant: notReady,
    updateThread: notReady,
    listThreads: notReady,
    linkParticipant: notReady,
    listThreadParticipants: notReady,
    insertMessage: notReady,
    findMessage: notReady,
    findMessageByExternalId: notReady,
    updateMessage: notReady,
    listMessages: notReady,
  } as InboxStore;
}
