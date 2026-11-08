/**
 * Engine audit events. Thin wrapper over the shared logAuditEvent in server/services/audit-log.ts.
 * Do not add a second audit writer here.
 *
 * The action must be a member of AuditAction in audit-log.ts. Adding a new action is a change
 * to that union and is made there, not in this engine.
 */

import { logAuditEvent } from '../../services/audit-log';
import type { AuditAction } from '../../services/audit-log';
import { ENGINE_NAME, ENGINE_VERSION } from './config';

export interface EngineAuditInput {
  action: AuditAction;
  provider: string;
  userId?: string;
  resourceId?: string;
  ipAddress?: string;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  metadata?: Record<string, unknown>;
}

export async function auditEngineEvent(input: EngineAuditInput): Promise<void> {
  await logAuditEvent({
    action: input.action,
    userId: input.userId,
    resourceType: ENGINE_NAME,
    resourceId: input.resourceId,
    ipAddress: input.ipAddress,
    severity: input.severity,
    metadata: {
      ...input.metadata,
      engine: ENGINE_NAME,
      engineVersion: ENGINE_VERSION,
      provider: input.provider,
    },
  });
}
