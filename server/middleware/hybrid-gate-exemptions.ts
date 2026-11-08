/**
 * Exact exemptions from the /api hybrid auth gate. A route listed here authenticates itself
 * (the RAG tool webhook checks WEBHOOK_TOKEN), and the gate would otherwise return 401 for it.
 * Each entry is one method and one path. Anything that does not match exactly, including a trailing
 * slash, a different case or an encoded variant, still goes through the gate (fail closed).
 */
export const HYBRID_GATE_EXEMPTIONS: ReadonlyArray<{ method: string; path: string }> = Object.freeze([
  Object.freeze({ method: 'POST', path: '/rag-knowledge/tool-webhook' }),
]);

/** True only for an exact method and path match. req.path is relative to the /api mount. */
export function isHybridGateExempt(method: string | undefined, path: string | undefined): boolean {
  return HYBRID_GATE_EXEMPTIONS.some((entry) => entry.method === method && entry.path === path);
}

/** Wraps the hybrid gate so only exempt requests skip it. Every other request reaches the gate unchanged. */
export function hybridGateUnlessExempt(gate: (req: any, res: any, next: any) => unknown) {
  return (req: any, res: any, next: any) => (isHybridGateExempt(req.method, req.path) ? next() : gate(req, res, next));
}
