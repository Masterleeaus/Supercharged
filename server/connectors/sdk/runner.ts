/**
 * Runs one connector action through the shared layers (#349): capability check, idempotency key on
 * writes, per-attempt timeout, bounded retries, field mapping and exactly one audit record.
 *
 * A connector only implements execute(). It never does its own retries, timeouts or audit.
 */
import { ConnectorError, type ConnectorCredentials, type ConnectorDefinition } from './contract.ts';
import { DEFAULT_RETRY_POLICY, idempotencyKeyFor, withRetries, withTimeout, type RetryPolicy } from './client.ts';
import { mapRecord, type EntityMapping } from './field-mapping.ts';
import { buildAuditRecord, type AuditSink } from './audit.ts';

export interface RunActionOptions {
  definition: ConnectorDefinition;
  companyId: string;
  action: string;
  input: unknown;
  credentials: ConnectorCredentials;
  /** Caller-supplied key for a write. When absent, a stable one is derived from stableId or a random one is made. */
  idempotencyKey?: string;
  /** Stable id of the logical write, so replays of the same write share one key. */
  stableId?: string;
  timeoutMs?: number;
  retry?: Partial<Omit<RetryPolicy, 'sleep' | 'random'>> & Pick<RetryPolicy, 'sleep' | 'random'>;
  /** Mapping from vendor records to canonical fields, applied to read results. */
  mapping?: EntityMapping;
  audit: AuditSink;
  now?: () => Date;
}

export interface RunActionResult {
  value: unknown;
  attempts: number;
  idempotencyKey: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runAction(options: RunActionOptions): Promise<RunActionResult> {
  const { definition, companyId, action } = options;
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const spec = Object.prototype.hasOwnProperty.call(definition.actions, action) ? definition.actions[action] : undefined;
  const isWrite = spec?.kind === 'write';
  let idempotencyKey: string | null = null;
  let attempts = 0;

  let value: unknown;
  let failure: ConnectorError | null = null;
  try {
    if (!spec) throw new ConnectorError('validation', `unknown action "${action}"`);
    if (!definition.capabilities.includes(spec.kind)) {
      throw new ConnectorError('forbidden', `connector does not support ${spec.kind}`);
    }
    if (isWrite) {
      idempotencyKey =
        options.idempotencyKey ??
        idempotencyKeyFor({ companyId, connector: definition.id, action, stableId: options.stableId });
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    const outcome = await withRetries(
      (attempt) => {
        attempts = attempt;
        return withTimeout(
          definition.execute({ action, input: options.input, idempotencyKey: idempotencyKey ?? undefined, timeoutMs }, options.credentials),
          timeoutMs,
        );
      },
      policy,
    );
    attempts = outcome.attempts;
    value = outcome.value;
    if (spec.kind === 'read' && options.mapping) value = mapResult(value, options.mapping);
  } catch (err) {
    failure = err instanceof ConnectorError ? err : new ConnectorError('unknown', 'Unexpected connector failure');
  }

  try {
    await options.audit(
      buildAuditRecord({
        companyId,
        connector: definition.id,
        action,
        idempotencyKey: idempotencyKey ?? undefined,
        outcome: failure ? 'failure' : 'success',
        errorCode: failure?.code,
        attempts,
        durationMs: Date.now() - started,
        payload: options.input,
        now: now(),
      }),
    );
  } catch {
    // The sink's message is not surfaced: it may contain detail from the storage layer.
    throw new ConnectorError('unknown', 'Connector action could not be audited');
  }

  if (failure) throw failure;
  return { value, attempts, idempotencyKey };
}

function mapResult(value: unknown, mapping: EntityMapping): unknown {
  if (Array.isArray(value)) return value.map((item) => mapRecord(item, mapping));
  if (value !== null && typeof value === 'object') return mapRecord(value, mapping);
  return value;
}
