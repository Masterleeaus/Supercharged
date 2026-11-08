/*
 * Desk adapter for the Interaction Engine offline companion (proprietary, see
 * NOTICE.md). The copied files in offline/ are unchanged. This file is Desk code.
 *
 * Rules:
 *  - company_id is required on every operation and is never read from a payload
 *    or request body. It becomes the outbox tenant id (metadata.tenant_id).
 *  - The secret is injected. Nothing is read from the environment, and there is
 *    no fallback. Missing, short or placeholder secrets are refused at construction.
 *  - Persistence must be injected. Without it every operation refuses.
 *  - This adapter never dispatches. Sync is not exposed. A future sync must check
 *    evaluateAuthority from server/modules/approvals/authority-ladder.ts first.
 */

import { EncryptedCommandOutbox } from './offline/command-outbox.ts';
import type { OfflineCommand, OfflineCommandInput, OutboxEnvelope, StorageAdapter } from './offline/types.ts';

export class DeskInteractionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'DeskInteractionError';
  }
}

/** Persistence Desk binds. Implementations must scope every read and write to the company. */
export interface DeskOutboxPersistence {
  forCompany(companyId: string): StorageAdapter<OutboxEnvelope>;
}

export interface DeskOutboxDependencies {
  /** Omit to get the refusing default: every operation throws persistence_not_injected. */
  persistence?: DeskOutboxPersistence;
  /** Injected device secret. Never read from the environment. */
  secret: string;
}

export interface EnqueueInput {
  companyId: string;
  userId: string | number | null;
  deviceId: string;
  capability: string;
  payload: Record<string, unknown>;
}

export const MIN_OUTBOX_SECRET_LENGTH = 32;

/** Literal fallbacks seen in other codebases. Refused so that none can be used by mistake. */
const KNOWN_PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'change-me',
  'change-this-approval-secret',
  'interaction-policy-eval-secret-2026',
]);

const refusingPersistence: DeskOutboxPersistence = Object.freeze({
  forCompany(): StorageAdapter<OutboxEnvelope> {
    throw new DeskInteractionError('persistence_not_injected');
  },
});

function requireCompanyId(companyId: unknown): string {
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    throw new DeskInteractionError('company_id_required');
  }
  return companyId;
}

function assertSecret(secret: unknown): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new DeskInteractionError('secret_not_injected');
  }
  if (KNOWN_PLACEHOLDER_SECRETS.has(secret)) {
    throw new DeskInteractionError('secret_is_placeholder');
  }
  if (secret.length < MIN_OUTBOX_SECRET_LENGTH) {
    throw new DeskInteractionError('secret_too_short');
  }
  return secret;
}

export class DeskInteractionOutbox {
  private readonly persistence: DeskOutboxPersistence;
  private readonly secret: string;

  constructor(deps: DeskOutboxDependencies) {
    this.secret = assertSecret(deps.secret);
    this.persistence = deps.persistence ?? refusingPersistence;
  }

  /** Builds an outbox bound to one company. Persistence is only touched here. */
  private outboxFor(companyId: unknown): { outbox: EncryptedCommandOutbox; companyId: string } {
    const id = requireCompanyId(companyId);
    return { outbox: new EncryptedCommandOutbox(this.persistence.forCompany(id), this.secret), companyId: id };
  }

  async enqueue(input: EnqueueInput): Promise<OutboxEnvelope> {
    const { outbox, companyId } = this.outboxFor(input.companyId);
    if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload)) {
      throw new DeskInteractionError('payload_must_be_object');
    }
    const command: OfflineCommandInput = {
      capability: input.capability,
      payload: input.payload,
      metadata: {
        tenant_id: companyId,
        user_id: input.userId,
        device_id: input.deviceId,
      },
    };
    return outbox.enqueue(command);
  }

  async pending(companyId: string): Promise<OutboxEnvelope[]> {
    return this.outboxFor(companyId).outbox.pending();
  }

  /** Decrypts one command. Refuses when the stored command belongs to another company. */
  async decrypt(companyId: string, id: string): Promise<OfflineCommand> {
    const { outbox, companyId: scope } = this.outboxFor(companyId);
    const command = await outbox.decrypt(id);
    if (command.metadata.tenant_id !== scope) {
      throw new DeskInteractionError('tenant_mismatch');
    }
    return command;
  }

  async markSyncing(companyId: string, id: string): Promise<void> {
    await this.outboxFor(companyId).outbox.markSyncing(id);
  }

  async markSynced(companyId: string, id: string): Promise<void> {
    await this.outboxFor(companyId).outbox.markSynced(id);
  }

  async markFailed(companyId: string, id: string, error: string): Promise<void> {
    await this.outboxFor(companyId).outbox.markFailed(id, error);
  }

  async markConflict(companyId: string, id: string, error?: string): Promise<void> {
    await this.outboxFor(companyId).outbox.markConflict(id, error);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.outboxFor(companyId).outbox.remove(id);
  }
}
