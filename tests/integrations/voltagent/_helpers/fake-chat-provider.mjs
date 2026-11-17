/**
 * Fake chat provider for VoltAgent tests. No network, no keys.
 * Replies come from a scripted queue; each call is recorded so tests can assert on it.
 */
export function createFakeChatProvider(script = []) {
  const queue = [...script];
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(structuredClone(request));
      if (queue.length === 0) {
        throw new Error('fake chat provider: no scripted reply left');
      }
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'string' ? { text: next, tool_calls: [] } : next;
    },
    remaining() {
      return queue.length;
    },
  };
}
