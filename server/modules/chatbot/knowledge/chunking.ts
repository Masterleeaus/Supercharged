/**
 * Text chunking and content hashing for the knowledge base. Pure functions, no storage, no network.
 *
 * Port of TrainingService / EmbedingService::splitIntoChunks (PHP). The PHP split on spaces and measured
 * bytes (strlen) against a 1024 limit. This port splits on paragraphs, then sentences, then words, and
 * measures an estimated token count (about 4 characters per token). See DECISIONS.md.
 */
import { createHash } from "node:crypto";

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_MAX_TOKENS = 512;

/** Rough token estimate. Deterministic, so a re-index of the same text produces the same chunks. */
export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Line endings to \n, runs of spaces collapsed, blank runs reduced to one blank line, trimmed. */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Q&A pairs keep the PHP form: "question : answer". */
export function qaText(question: string, answer: string): string {
  return `${question.trim()} : ${answer.trim()}`;
}

interface Piece {
  readonly text: string;
  /** Separator placed before this piece when it joins the chunk being built. */
  readonly sep: string;
}

function splitPieces(text: string, maxChars: number): Piece[] {
  const out: Piece[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const para = paragraph.trim();
    if (!para) continue;
    if (para.length <= maxChars) {
      out.push({ text: para, sep: "\n\n" });
      continue;
    }
    let paraStart = true;
    const push = (value: string) => {
      out.push({ text: value, sep: paraStart ? "\n\n" : " " });
      paraStart = false;
    };
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length <= maxChars) {
        push(s);
        continue;
      }
      for (const word of s.split(/\s+/)) {
        if (word.length <= maxChars) {
          push(word);
          continue;
        }
        // A single run longer than the limit (for example a long URL) is cut into pieces that join with no space.
        for (let i = 0; i < word.length; i += maxChars) {
          out.push({ text: word.slice(i, i + maxChars), sep: "" });
        }
        paraStart = false;
      }
    }
  }
  return out;
}

/**
 * Splits text into chunks of at most maxTokens (estimated). No chunk is empty, and no chunk is longer
 * than the limit. Chunks do not overlap.
 */
export function chunkText(input: string, maxTokens: number = DEFAULT_MAX_TOKENS): string[] {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError("maxTokens must be a positive integer");
  }
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const pieces = splitPieces(normalizeText(input), maxChars);
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current === "") {
      current = piece.text;
      continue;
    }
    const joined = current + piece.sep + piece.text;
    if (joined.length <= maxChars) {
      current = joined;
    } else {
      chunks.push(current);
      current = piece.text;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/** SHA-256 hex of a string. Used for source and chunk content hashes. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Chunk id derived from the source, the position and the chunk text. The storage derives the same id,
 * so the indexer can write embeddings that point at chunks before the rows exist (see DECISIONS.md).
 */
export function chunkIdFor(sourceId: string, ordinal: number, contentHash: string): string {
  return hashText(`${sourceId}\u001f${ordinal}\u001f${contentHash}`);
}
