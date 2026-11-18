/**
 * Text chunker for the VoltAgent RAG path (Phase 1, W4, issue #378).
 *
 * Uses VoltAgent's own chunkers from @voltagent/rag (MIT):
 * - SentenceChunker groups whole sentences up to maxTokens, with overlapSentences sentences shared between
 *   neighbours. This is the main path.
 * - TokenChunker is a fallback for a single sentence that is longer than maxTokens. The sentence chunker does
 *   not split such a sentence, so the fallback keeps every chunk within the token limit.
 *
 * RecursiveChunker is not used. In @voltagent/rag 1.0.2 with overlap set, it repeats text and cuts words in
 * half (for example "Sevent" then "een"), so its output is not safe for retrieval.
 *
 * Sizes are counted in tokens, where a token is one whitespace-separated word (whitespaceTokenizer). The same
 * tokenizer is used for the sentence grouping and for the size check, so both agree.
 *
 * Output is deterministic: the same input always gives the same chunks.
 *
 * Licence: original TitanZero code. It imports the MIT @voltagent/rag package and copies no Mastra source.
 */
import { SentenceChunker, TokenChunker, whitespaceTokenizer } from '@voltagent/rag';

export interface ChunkOptions {
  /** Maximum tokens per chunk. */
  maxTokens: number;
  /** Whole sentences shared between consecutive chunks. Zero means no overlap. */
  overlapSentences: number;
}

export interface TextChunk {
  index: number;
  text: string;
}

export const MAX_CHUNK_TOKENS = 2000;
const MAX_OVERLAP_SENTENCES = 10;

export function chunkText(input: string, options: ChunkOptions): TextChunk[] {
  if (typeof input !== 'string') throw new Error('chunk_input_invalid');
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > MAX_CHUNK_TOKENS) {
    throw new Error('chunk_size_invalid');
  }
  if (
    !Number.isSafeInteger(options.overlapSentences) ||
    options.overlapSentences < 0 ||
    options.overlapSentences > MAX_OVERLAP_SENTENCES
  ) {
    throw new Error('chunk_overlap_invalid');
  }
  const text = input.trim();
  if (text.length === 0) return [];

  const sentenceChunks = new SentenceChunker(whitespaceTokenizer).chunk(text, {
    maxTokens: options.maxTokens,
    overlapSentences: options.overlapSentences,
    tokenizer: whitespaceTokenizer,
  });

  const pieces: string[] = [];
  for (const chunk of sentenceChunks) {
    const content = chunk.content.trim();
    if (content.length === 0) continue;
    if (whitespaceTokenizer.countTokens(content) <= options.maxTokens) {
      pieces.push(content);
      continue;
    }
    for (const sub of new TokenChunker(whitespaceTokenizer).chunk(content, { maxTokens: options.maxTokens, overlap: 0, tokenizer: whitespaceTokenizer })) {
      const subText = sub.content.trim();
      if (subText.length > 0) pieces.push(subText);
    }
  }
  return pieces.map((piece, index) => ({ index, text: piece }));
}
