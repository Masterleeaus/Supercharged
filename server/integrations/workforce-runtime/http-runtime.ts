/**
 * HTTP client for the Titan workforce runtime. Built only when TITAN_WORKFORCE_URL and
 * TITAN_WORKFORCE_SECRET are both valid (see index.ts).
 *
 * Guarantees:
 *  - https only, or http on 127.0.0.1 and localhost. Origin only, no credentials or paths.
 *  - Redirects are never followed. A 3xx response is refused.
 *  - Every request has a timeout and a bounded response size.
 *  - Every request is signed (see wire.mjs). The secret is never logged or put in an error.
 *  - Errors carry a stable code only. Request and response bodies are never echoed.
 *
 * ASSUMED: the endpoint paths, the header names and the canonical signing string are not yet
 * verified against services/workforce. See docs/WORKFORCE_RUNTIME.md before enabling.
 */
import type { WorkforceHealth, WorkforceRuntimePort, WorkforceTask, WorkforceTaskInput } from './port.ts';
// @ts-ignore pure ESM helper shared with tests
import { WorkforceRuntimeError, parseRuntimeUrl, requireSecret, signWorkforceRequest, validateSubmitTask, validateTaskId, parseTaskRecord, parseHealthRecord, taskPath, ENDPOINTS, TIMESTAMP_HEADER, SIGNATURE_HEADER, MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS } from './wire.mjs';

export interface HttpWorkforceRuntimeOptions {
  /** Origin only, for example https://runtime.example or http://127.0.0.1:4010. */
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

type Method = 'GET' | 'POST';

/**
 * Decision: only the in-process tool registry executes actions. This client carries TASKS only.
 * Any action or tool-execution request is refused before a request is built, so nothing is sent.
 */
const ACTION_REFUSAL = 'actions_not_allowed_over_http';
const ACTION_SEGMENTS = new Set(['action', 'actions', 'tool', 'tools', 'execute', 'execution', 'invoke']);
const ACTION_WORKFLOW = /^(action|tool)s?([._-]|$)/i;
const ACTION_PATH = /^\/v1\/(actions?|tools?|execute|execution|invoke)(\/|$)/i;
const MAX_SCAN_DEPTH = 12;

export class HttpWorkforceRuntime implements WorkforceRuntimePort {
  readonly kind = 'http' as const;
  private readonly origin: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpWorkforceRuntimeOptions) {
    // Validate again here so that a caller cannot skip index.ts and bypass the URL rules.
    this.origin = parseRuntimeUrl(options.baseUrl);
    this.secret = requireSecret(options.secret);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
      throw new WorkforceRuntimeError('runtime_invalid_input');
    }
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async submitTask(task: WorkforceTaskInput): Promise<WorkforceTask> {
    refuseIfActionRequest(task);
    const body = JSON.stringify(validateSubmitTask(task));
    // ASSUMED: POST /v1/tasks
    const raw = await this.request('POST', ENDPOINTS.submitTask.path, body);
    return parseTaskRecord(raw);
  }

  async getTask(id: string): Promise<WorkforceTask> {
    const checked = validateTaskId(id);
    // ASSUMED: GET /v1/tasks/:id
    const raw = await this.request('GET', taskPath(ENDPOINTS.getTask.path, checked), null);
    return parseTaskRecord(raw, checked);
  }

  async cancelTask(id: string): Promise<WorkforceTask> {
    const checked = validateTaskId(id);
    // ASSUMED: POST /v1/tasks/:id/cancel with an empty body
    const raw = await this.request('POST', taskPath(ENDPOINTS.cancelTask.path, checked), null);
    return parseTaskRecord(raw, checked);
  }

  async health(): Promise<WorkforceHealth> {
    // ASSUMED: GET /v1/health
    const raw = await this.request('GET', ENDPOINTS.health.path, null);
    return parseHealthRecord(raw);
  }

  private async request(method: Method, path: string, bodyText: string | null): Promise<unknown> {
    if (ACTION_PATH.test(path)) throw new WorkforceRuntimeError(ACTION_REFUSAL);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = bodyText ?? '';
    const signature = signWorkforceRequest({ secret: this.secret, method, path, timestamp, body });
    const headers: Record<string, string> = {
      accept: 'application/json',
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signature,
    };
    if (bodyText !== null) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers,
        body: bodyText ?? undefined,
        // 'manual' hands back the 3xx response instead of following it, so it can be refused.
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw classifyTransportError(error);
    }

    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      throw new WorkforceRuntimeError('runtime_redirect_refused', { status: response.status });
    }
    if (!response.ok) {
      await discardBody(response);
      const retryable = response.status === 429 || response.status >= 500;
      throw new WorkforceRuntimeError('runtime_http_error', { status: response.status, retryable });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw classifyTransportError(error);
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new WorkforceRuntimeError('runtime_bad_response');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new WorkforceRuntimeError('runtime_bad_response');
    }
  }
}

/**
 * Refuses a submit that asks for an action or tool execution: an action or tool workflow, a
 * resource of that kind, or any action or tool key anywhere in the input. Scanning is fail
 * closed: input nested deeper than the limit is refused as invalid rather than passed on.
 */
function refuseIfActionRequest(input: unknown): void {
  if (typeof input !== 'object' || input === null) return;
  const record = input as Record<string, unknown>;
  if (typeof record.workflow === 'string' && ACTION_WORKFLOW.test(record.workflow)) {
    throw new WorkforceRuntimeError(ACTION_REFUSAL);
  }
  const resource = record.resource;
  if (typeof resource === 'object' && resource !== null && typeof (resource as { kind?: unknown }).kind === 'string'
    && keySignalsAction((resource as { kind: string }).kind)) {
    throw new WorkforceRuntimeError(ACTION_REFUSAL);
  }
  if (containsActionKey(input, 0, new Set<object>())) throw new WorkforceRuntimeError(ACTION_REFUSAL);
}

function keySignalsAction(key: string): boolean {
  return key.split(/[_\-.\s]+/).some((segment) => ACTION_SEGMENTS.has(segment.toLowerCase()));
}

function containsActionKey(value: unknown, depth: number, seen: Set<object>): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (depth > MAX_SCAN_DEPTH) throw new WorkforceRuntimeError('runtime_invalid_input');
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (keySignalsAction(key)) return true;
    if (containsActionKey(child, depth + 1, seen)) return true;
  }
  return false;
}

function classifyTransportError(error: unknown): Error {
  // Deliberately ignores error.message: it can contain URLs, headers or other request detail.
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new WorkforceRuntimeError('runtime_timeout', { retryable: true });
  }
  return new WorkforceRuntimeError('runtime_unreachable', { retryable: true });
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to do: the response is already refused.
  }
}
