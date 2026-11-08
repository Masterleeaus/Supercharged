/**
 * Cosine similarity in application code. Port of KnowledgeBase::cosineSimilarity (PHP).
 * A zero-length vector scores 0, as in the PHP. Mismatched lengths throw: vectors from different models
 * must never be compared, so a silent truncation would hide a bug.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RangeError("vector contains a non-finite value");
    }
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Floating point can push a score a hair outside [-1, 1].
  return Math.max(-1, Math.min(1, score));
}
