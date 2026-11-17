/**
 * Scripted fake chat provider for tests. It follows the ChatProviderContract shape in
 * server/services/ai-runtime/contracts.ts: chat(input) resolves to a success or a failure object, never throws.
 *
 * Script entries, used in order, one per call:
 *   'some text'                              -> success with that content
 *   { content, usage? }                      -> success with content and optional token usage
 *   { fail: 503 }                            -> failure with that HTTP status
 *   { fail: null }                           -> transport failure (no status)
 *   { fail: 400, retryable: false, error? }  -> failure with explicit retryable flag and error text
 *
 * When the script runs out, the provider returns a failure with error 'script_exhausted' and status null.
 * A script is not needed when failWith is set: every call then fails with that status (sticky failure).
 *
 * No network, no timers, no environment reads. Every call is recorded in `calls`.
 */

const FAILOVER_STATUSES = [429, 500, 502, 503, 504];

/**
 * @param {object} [options]
 * @param {string} [options.name='fake-chat'] provider name reported in results
 * @param {Array<string|object>} [options.script=[]] scripted replies, consumed in order
 * @param {number|null} [options.failWith] when set, every call fails with this HTTP status (null is not allowed here, use a script)
 * @param {string} [options.model='fake-model']
 */
export function createFakeChatProvider(options = {}) {
  const name = options.name ?? 'fake-chat';
  const model = options.model ?? 'fake-model';
  const queue = [...(options.script ?? [])];
  const failWith = options.failWith ?? null;
  const calls = [];

  function failure(error, status, retryable) {
    return { ok: false, provider: name, error, status, retryable, latency_ms: 0 };
  }

  function fromEntry(entry) {
    if (typeof entry === 'string') {
      return { ok: true, provider: name, model, content: entry, usage: null, latency_ms: 0 };
    }
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'fail')) {
      const status = entry.fail;
      const retryable = typeof entry.retryable === 'boolean'
        ? entry.retryable
        : status === null || FAILOVER_STATUSES.includes(status);
      return failure(entry.error ?? (status === null ? 'transport_error' : `http_${status}`), status, retryable);
    }
    if (entry && typeof entry === 'object' && typeof entry.content === 'string') {
      return { ok: true, provider: name, model, content: entry.content, usage: entry.usage ?? null, latency_ms: 0 };
    }
    throw new TypeError('fake chat provider: script entry must be a string, {content}, or {fail}');
  }

  return {
    /** Every chat call, in order: { companyId, messages, options }. */
    calls,

    providerName() {
      return name;
    },

    async chat(input) {
      calls.push({
        companyId: input?.companyId,
        messages: input?.messages,
        options: input?.options,
      });
      if (failWith !== null) {
        return failure(`http_${failWith}`, failWith, FAILOVER_STATUSES.includes(failWith));
      }
      if (queue.length === 0) return failure('script_exhausted', null, false);
      return fromEntry(queue.shift());
    },

    /** Adds one more scripted entry at the end of the queue. */
    enqueue(entry) {
      queue.push(entry);
    },

    /** Entries not yet used. */
    remaining() {
      return queue.length;
    },

    async health() {
      return { ok: failWith === null, provider: name, reason: failWith === null ? null : `http_${failWith}` };
    },
  };
}
