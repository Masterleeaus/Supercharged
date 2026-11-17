/**
 * Text chunker for the VoltAgent RAG path (Phase 1, W4, issue #378).
 *
 * Splits text into overlapping character windows. It prefers to end a window at whitespace so words are
 * not cut in half. Output is deterministic: the same input always gives the same chunks.
 *
 * The issue asks for VoltAgent's chunkers. Those are not verified here, because node_modules/@voltagent is
 * empty in this checkout. This is a small local stand-in with the same job.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 */
export interface ChunkOptions {
  /** Maximum characters per chunk. */
  size: number;
  /** Characters shared by consecutive chunks. Must be smaller than size. */
  overlap: number;
}

export interface TextChunk {
  index: number;
  text: string;
}

export const MAX_CHUNK_SIZE = 8000;

export function chunkText(input: string, options: ChunkOptions): TextChunk[] {
  if (typeof input !== 'string') throw new Error('chunk_input_invalid');
  if (!Number.isSafeInteger(options.size) || options.size < 1 || options.size > MAX_CHUNK_SIZE) {
    throw new Error('chunk_size_invalid');
  }
  if (!Number.isSafeInteger(options.overlap) || options.overlap < 0 || options.overlap >= options.size) {
    throw new Error('chunk_overlap_invalid');
  }
  const text = input.trim();
  if (text.length === 0) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + options.size, text.length);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > start + Math.floor(options.size / 2)) end = lastSpace;
    }
    const piece = text.slice(start, end).trim();
    if (piece.length > 0) chunks.push({ index: chunks.length, text: piece });
    if (end >= text.length) break;
    const next = end - options.overlap;
    start = next > start ? next : end;
  }
  return chunks;
}
