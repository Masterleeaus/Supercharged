export type JsonRecord = Record<string, unknown>;

export interface StorageAdapter<T> {
  put(id: string, value: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  all(): Promise<T[]>;
  delete(id: string): Promise<void>;
}

export interface OfflineCommandInput {
  capability: string;
  payload: JsonRecord;
  metadata: {
    tenant_id: string;
    user_id: string | number | null;
    device_id: string;
    [key: string]: unknown;
  };
}

export interface OfflineCommand extends OfflineCommandInput {
  id: string;
  createdAt: string;
}

export interface OutboxEnvelope {
  id: string;
  algorithm: 'AES-256-GCM';
  iv: string;
  ciphertext: string;
  status: 'pending' | 'syncing' | 'synced' | 'conflict' | 'failed';
  attempts: number;
  queuedAt: string;
  syncedAt?: string;
  lastError?: string;
}

export interface WizardDraft {
  id: string;
  wizardId: string;
  version: string;
  tenantId: string;
  userId: string | number | null;
  deviceId: string;
  stepIndex: number;
  data: JsonRecord;
  attachments: string[];
  syncStatus: 'local' | 'syncing' | 'synced' | 'conflict';
  createdAt: string;
  updatedAt: string;
}

export interface LanguageUnderstanding {
  intent: string;
  confidence: number;
  entities: {
    customer?: string;
    relativeDate?: string;
    service?: string;
    amount?: number;
  };
  normalized: string;
}

export type CognitiveEventType =
  | 'observation_recorded'
  | 'intent_inferred'
  | 'candidate_generated'
  | 'constraint_rejected'
  | 'recommendation_created'
  | 'clarification_requested'
  | 'user_corrected'
  | 'user_approved'
  | 'user_rejected'
  | 'command_prepared'
  | 'command_executed'
  | 'command_failed'
  | 'outcome_observed'
  | 'prediction_scored'
  | 'memory_created'
  | 'memory_disputed'
  | 'model_updated';

export interface OfflineCognitiveEventInput {
  eventType: CognitiveEventType;
  tenantId: string;
  userId?: string | number | null;
  deviceId: string;
  correlationId: string;
  sequence: number;
  payload: JsonRecord;
  privacyClass?: 'device_private' | 'user_private' | 'tenant_private' | 'aggregate_safe';
}

export interface OfflineCognitiveEvent extends OfflineCognitiveEventInput {
  eventId: string;
  occurredAt: string;
}

export interface CognitiveEventEnvelope {
  id: string;
  algorithm: 'AES-256-GCM';
  iv: string;
  ciphertext: string;
  correlationId: string;
  sequence: number;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  attempts: number;
  queuedAt: string;
  lastError?: string;
}
