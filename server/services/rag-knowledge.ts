/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
/**
 * RAG Knowledge Service
 * 
 * Scalable knowledge base system using Retrieval-Augmented Generation (RAG).
 * Stores knowledge locally with embeddings instead of using ElevenLabs 20MB limit.
 * 
 * Features:
 * - Document chunking with configurable overlap
 * - OpenAI embeddings generation
 * - Vector similarity search (cosine similarity)
 * - Per-user storage limits (20MB default)
 * - Async processing queue for large documents
 * 
 * This is a SEPARATE system from the legacy ElevenLabs KB.
 * Set USE_RAG_KNOWLEDGE=true to enable this system.
 */

import OpenAI from "openai";
import { db } from "../db";
import { 
  knowledgeBase, 
  knowledgeChunks, 
  knowledgeProcessingQueue,
  userKnowledgeStorageLimits,
  globalSettings,
  users,
  type KnowledgeChunk,
  type KnowledgeBase
} from "@shared/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { logger } from "../utils/logger";

/**
 * Tenant scope required by every knowledge search. Both values must come from the verified session
 * (res.locals.companyId and the authenticated user), never from a request body, query or params.
 */
export interface KnowledgeSearchScope {
  companyId: string;
  userId: string;
}

export type KnowledgeScopeErrorCode = 'company_scope_required' | 'user_scope_required' | 'scope_mismatch';

/** Thrown before any database or embedding call when the scope is missing or does not match the user. */
export class KnowledgeScopeError extends Error {
  readonly code: KnowledgeScopeErrorCode;

  constructor(code: KnowledgeScopeErrorCode) {
    super('Knowledge search refused.');
    this.name = 'KnowledgeScopeError';
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEARCH_RESULTS = 20;

/**
 * Refuse unless the scope names a company and the user belongs to that company.
 * Fails closed: a user with no company, or a company that differs from the user's, gets nothing.
 */
async function assertKnowledgeScope(scope: unknown): Promise<KnowledgeSearchScope> {
  const candidate = scope as Partial<KnowledgeSearchScope> | null | undefined;
  if (!candidate || typeof candidate !== 'object') {
    throw new KnowledgeScopeError('company_scope_required');
  }
  if (typeof candidate.companyId !== 'string' || !UUID_PATTERN.test(candidate.companyId)) {
    throw new KnowledgeScopeError('company_scope_required');
  }
  if (typeof candidate.userId !== 'string' || candidate.userId.length === 0 || candidate.userId.length > 255) {
    throw new KnowledgeScopeError('user_scope_required');
  }

  const [member] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, candidate.userId), eq(users.companyId, candidate.companyId)))
    .limit(1);
  if (!member) {
    throw new KnowledgeScopeError('scope_mismatch');
  }

  return { companyId: candidate.companyId, userId: candidate.userId };
}

// the newest OpenAI model is "gpt-5" which was released August 7, 2025
// Using text-embedding-3-small for cost-effective embeddings
let embeddingModel = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

// Chunking configuration
const CHUNK_SIZE = 500; // tokens (roughly 2000 chars)
const CHUNK_OVERLAP = 50; // tokens overlap between chunks
const MAX_CHUNK_CHARS = 2000; // approximate chars per chunk

// Default storage limit per user (20MB)
const DEFAULT_STORAGE_LIMIT_BYTES = 20 * 1024 * 1024;

// Initialize OpenAI client
let openaiClient: OpenAI | null = null;
let lastApiKey: string | null = null;

async function getOpenAIClient(): Promise<OpenAI> {
  let apiKey = '';
  let baseURL: string | undefined = undefined;

  // 1. Try to get OpenAI API key
  try {
    const [dbSetting] = await db
      .select()
      .from(globalSettings)
      .where(eq(globalSettings.key, 'openai_api_key'))
      .limit(1);
    if (dbSetting?.value) {
      apiKey = dbSetting.value as string;
    }
  } catch (e: any) {
    logger.warn('Could not read OpenAI key from settings; falling back to environment', { error: e?.message }, 'RagKnowledge');
  }

  if (!apiKey && process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
  }

  // 2. If no OpenAI key, try OpenRouter API key
  if (!apiKey) {
    try {
      const [dbSetting] = await db
        .select()
        .from(globalSettings)
        .where(eq(globalSettings.key, 'openrouter_api_key'))
        .limit(1);
      if (dbSetting?.value) {
        apiKey = dbSetting.value as string;
        baseURL = 'https://openrouter.ai/api/v1';
        embeddingModel = 'openai/text-embedding-3-small'; // OpenRouter model path
      }
    } catch (e: any) {
      logger.warn('Could not read OpenRouter key from settings', { error: e?.message }, 'RagKnowledge');
    }
  }

  if (!apiKey && process.env.OPENROUTER_API_KEY) {
    apiKey = process.env.OPENROUTER_API_KEY;
    baseURL = 'https://openrouter.ai/api/v1';
    embeddingModel = 'openai/text-embedding-3-small';
  }

  if (!apiKey) {
    throw new Error("No API key found for embeddings. Configure either openai_api_key or openrouter_api_key in Admin Settings.");
  }

  const clientKey = `${apiKey}_${baseURL || 'default'}`;
  // Recreate client if API key or endpoint changed
  if (!openaiClient || lastApiKey !== clientKey) {
    openaiClient = new OpenAI({ 
      apiKey, 
      baseURL,
      timeout: 10000 
    });
    lastApiKey = clientKey;
  }
  
  return openaiClient;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have same length");
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Split text into chunks with overlap
 */
function chunkText(text: string, maxChars: number = MAX_CHUNK_CHARS, overlapChars: number = 200): string[] {
  const chunks: string[] = [];
  
  // Clean and normalize text
  const cleanText = text.replace(/\s+/g, ' ').trim();
  
  if (cleanText.length <= maxChars) {
    return [cleanText];
  }
  
  let start = 0;
  while (start < cleanText.length) {
    let end = start + maxChars;
    
    // Try to break at sentence boundary
    if (end < cleanText.length) {
      const lastPeriod = cleanText.lastIndexOf('.', end);
      const lastNewline = cleanText.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      
      if (breakPoint > start + maxChars / 2) {
        end = breakPoint + 1;
      }
    }
    
    const chunk = cleanText.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    
    // Move start with overlap
    start = end - overlapChars;
    if (start >= cleanText.length) break;
  }
  
  return chunks;
}

/**
 * Convert structured JSON to clean, human-readable text chunks
 */
function parseJsonToChunks(data: any): string[] {
  const chunks: string[] = [];

  function traverse(node: any, path: string = ''): void {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      if (node.length > 0 && typeof node[0] === 'object' && node[0] !== null) {
        for (const item of node) {
          const itemText = objectToReadableText(item, path);
          if (itemText) chunks.push(itemText);
        }
      } else {
        chunks.push(`${path}: ${node.join(', ')}`);
      }
    } else if (typeof node === 'object') {
      const keys = Object.keys(node);
      const hasNested = keys.some(k => typeof node[k] === 'object' && node[k] !== null);

      if (!hasNested && keys.length > 0) {
        const itemText = objectToReadableText(node, path);
        if (itemText) chunks.push(itemText);
      } else {
        for (const key of keys) {
          const cleanKey = key.replace(/_/g, ' ');
          const subPath = path ? `${path} > ${cleanKey}` : cleanKey;
          traverse(node[key], subPath);
        }
      }
    } else {
      chunks.push(`${path}: ${node}`);
    }
  }

  function objectToReadableText(obj: any, prefix: string): string {
    const parts: string[] = [];
    if (prefix) {
      parts.push(`[Category: ${prefix}]`);
    }

    const titleKeys = ['title', 'name', 'question', 'subject', 'key'];
    const foundTitleKey = Object.keys(obj).find(k => titleKeys.includes(k.toLowerCase()));
    
    if (foundTitleKey) {
      parts.push(`${foundTitleKey.toUpperCase()}: ${obj[foundTitleKey]}`);
    }

    for (const [key, val] of Object.entries(obj)) {
      if (key === foundTitleKey) continue;
      if (val === null || val === undefined) continue;

      const cleanKey = key.replace(/_/g, ' ');
      if (typeof val === 'object') {
        parts.push(`${cleanKey}: ${JSON.stringify(val)}`);
      } else {
        parts.push(`${cleanKey}: ${val}`);
      }
    }

    return parts.join('\n');
  }

  traverse(data);
  return chunks;
}

/**
 * Generate embedding for text using OpenAI
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const openai = await getOpenAIClient();
  
  const response = await openai.embeddings.create({
    model: embeddingModel,
    input: text,
  });
  
  return response.data[0].embedding;
}

/**
 * Estimate token count (rough approximation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

export class RAGKnowledgeService {
  
  /**
   * Get or create storage limit for user
   */
  static async getUserStorageLimit(userId: string): Promise<{ maxBytes: number; usedBytes: number }> {
    const [existing] = await db
      .select()
      .from(userKnowledgeStorageLimits)
      .where(eq(userKnowledgeStorageLimits.userId, userId));
    
    if (existing) {
      return { maxBytes: existing.maxStorageBytes, usedBytes: existing.usedStorageBytes };
    }
    
    // Create default limit
    await db.insert(userKnowledgeStorageLimits).values({
      userId,
      maxStorageBytes: DEFAULT_STORAGE_LIMIT_BYTES,
      usedStorageBytes: 0,
    });
    
    return { maxBytes: DEFAULT_STORAGE_LIMIT_BYTES, usedBytes: 0 };
  }
  
  /**
   * Update used storage for user
   */
  static async updateUsedStorage(userId: string, deltaBytes: number): Promise<void> {
    await db
      .update(userKnowledgeStorageLimits)
      .set({ 
        usedStorageBytes: sql`${userKnowledgeStorageLimits.usedStorageBytes} + ${deltaBytes}`,
        updatedAt: new Date()
      })
      .where(eq(userKnowledgeStorageLimits.userId, userId));
  }
  
  /**
   * Check if user has enough storage space
   */
  static async checkStorageSpace(userId: string, requiredBytes: number): Promise<boolean> {
    const { maxBytes, usedBytes } = await this.getUserStorageLimit(userId);
    return (usedBytes + requiredBytes) <= maxBytes;
  }
  
  /**
   * Process and store knowledge base item with embeddings
   */
  static async processKnowledgeItem(
    knowledgeBaseId: string, 
    userId: string, 
    content: string,
    metadata?: Record<string, any>
  ): Promise<{ success: boolean; chunksCreated: number; error?: string }> {
    try {
      logger.info(`[RAG] Processing knowledge item ${knowledgeBaseId} for user ${userId}`);
      
      // Check storage limit
      const contentSize = Buffer.byteLength(content, 'utf8');
      const hasSpace = await this.checkStorageSpace(userId, contentSize);
      
      if (!hasSpace) {
        return { 
          success: false, 
          chunksCreated: 0, 
          error: "Storage limit exceeded. Please delete some knowledge items or upgrade your plan." 
        };
      }
      
      // Create processing queue entry
      const [queueEntry] = await db
        .insert(knowledgeProcessingQueue)
        .values({
          knowledgeBaseId,
          userId,
          status: 'processing',
        })
        .returning();
      
      // Split into chunks
      let chunks: string[] = [];
      let isJson = false;

      const trimmedContent = content.trim();
      if (
        metadata?.mimeType === 'application/json' ||
        metadata?.filename?.endsWith('.json') ||
        trimmedContent.startsWith('{') ||
        trimmedContent.startsWith('[')
      ) {
        try {
          const jsonData = JSON.parse(content);
          chunks = parseJsonToChunks(jsonData);
          isJson = true;
          logger.info(`[RAG] Successfully parsed JSON content into ${chunks.length} logical chunks`);
        } catch (jsonErr: any) {
          logger.warn(`[RAG] Failed to parse content as JSON, falling back to text chunking:`, jsonErr.message);
        }
      }

      if (!isJson) {
        chunks = chunkText(content);
      }

      // Ensure no chunk exceeds MAX_CHUNK_CHARS
      let finalChunks: string[] = [];
      for (const chunk of chunks) {
        if (chunk.length > MAX_CHUNK_CHARS) {
          finalChunks.push(...chunkText(chunk));
        } else {
          finalChunks.push(chunk);
        }
      }
      chunks = finalChunks;

      logger.info(`[RAG] Created ${chunks.length} chunks from content`);
      
      // Update queue with total chunks
      await db
        .update(knowledgeProcessingQueue)
        .set({ totalChunks: chunks.length })
        .where(eq(knowledgeProcessingQueue.id, queueEntry.id));
      
      // Process each chunk
      let processedCount = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i];
        
        try {
          // Generate embedding
          const embedding = await generateEmbedding(chunkText);
          
          // Store chunk with embedding
          await db.insert(knowledgeChunks).values({
            knowledgeBaseId,
            userId,
            chunkIndex: i,
            chunkText,
            embedding: embedding as any, // Store as JSON array
            tokenCount: estimateTokens(chunkText),
            metadata: { ...metadata, chunkIndex: i, totalChunks: chunks.length },
          });
          
          processedCount++;
          
          // Update progress
          await db
            .update(knowledgeProcessingQueue)
            .set({ processedChunks: processedCount, updatedAt: new Date() })
            .where(eq(knowledgeProcessingQueue.id, queueEntry.id));
          
        } catch (chunkError: any) {
          logger.error(`[RAG] Error processing chunk ${i}:`, chunkError.message);
          // If the knowledge base was deleted, foreign key constraint is violated (PG code 23503).
          // Stop processing immediately to avoid log spam and unnecessary API calls.
          if (chunkError.code === '23503' || chunkError.message?.includes('foreign key constraint')) {
            logger.info(`[RAG] Knowledge base ${knowledgeBaseId} was deleted. Stopping chunk processing.`);
            break;
          }
        }
        
        // Small delay to avoid rate limits
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      // Update storage used
      await this.updateUsedStorage(userId, contentSize);
      
      // Mark as completed
      await db
        .update(knowledgeProcessingQueue)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(knowledgeProcessingQueue.id, queueEntry.id));
      
      logger.info(`[RAG] Successfully processed ${processedCount}/${chunks.length} chunks`);
      
      return { success: true, chunksCreated: processedCount };
      
    } catch (error: any) {
      logger.error(`[RAG] Error processing knowledge item:`, error.message);
      
      // Mark as failed
      await db
        .update(knowledgeProcessingQueue)
        .set({ status: 'failed', errorMessage: error.message, updatedAt: new Date() })
        .where(eq(knowledgeProcessingQueue.knowledgeBaseId, knowledgeBaseId));
      
      return { success: false, chunksCreated: 0, error: error.message };
    }
  }
  
  /**
   * Search knowledge base using semantic similarity
   */
  static async searchKnowledge(
    scope: KnowledgeSearchScope,
    query: string,
    knowledgeBaseIds: string[],
    maxResults: number = 5
  ): Promise<Array<{ chunk: KnowledgeChunk; score: number; source: string }>> {
    // Refuse before any database or embedding call when the company scope is missing or mismatched.
    const { companyId, userId } = await assertKnowledgeScope(scope);

    if (typeof query !== 'string' || query.trim().length === 0) {
      return [];
    }
    if (!Array.isArray(knowledgeBaseIds)) {
      return [];
    }
    const ids = knowledgeBaseIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) {
      return [];
    }
    const limit = Number.isFinite(maxResults)
      ? Math.min(Math.max(1, Math.floor(maxResults)), MAX_SEARCH_RESULTS)
      : 5;

    try {
      logger.info(`[RAG] Searching knowledge (${ids.length} bases)`);

      // Generate embedding for query
      const queryEmbedding = await generateEmbedding(query);

      // Only chunks of knowledge bases owned by the caller's company, uploaded by this user.
      // Chunks are not stamped with a company on write, so the company is read from the knowledge base row.
      const rows = await db
        .select({ chunk: knowledgeChunks })
        .from(knowledgeChunks)
        .innerJoin(knowledgeBase, eq(knowledgeBase.id, knowledgeChunks.knowledgeBaseId))
        .where(
          and(
            inArray(knowledgeChunks.knowledgeBaseId, ids),
            eq(knowledgeChunks.userId, userId),
            eq(knowledgeBase.companyId, companyId)
          )
        );

      if (rows.length === 0) {
        logger.warn(`[RAG] No chunks found for knowledge bases`);
        return [];
      }

      logger.info(`[RAG] Searching ${rows.length} chunks`);

      // Calculate similarity scores
      const scoredChunks = rows
        .map(({ chunk }) => chunk)
        .filter(chunk => chunk.embedding && Array.isArray(chunk.embedding))
        .map(chunk => ({
          chunk,
          score: cosineSimilarity(queryEmbedding, chunk.embedding as number[]),
          source: chunk.knowledgeBaseId
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      logger.info(`[RAG] Found ${scoredChunks.length} relevant chunks (top score: ${scoredChunks[0]?.score.toFixed(3) || 'N/A'})`);

      return scoredChunks;

    } catch (error: any) {
      // Surface a failure as a failure, not as "no results". The provider message is not returned.
      logger.error(`[RAG] Search error:`, error.message);
      throw new Error('Knowledge search failed.');
    }
  }
  
  /**
   * Format search results for agent consumption
   */
  static formatResultsForAgent(
    results: Array<{ chunk: KnowledgeChunk; score: number; source: string }>,
    maxTokens: number = 500
  ): string {
    if (results.length === 0) {
      return "No relevant information found in the knowledge base.";
    }
    
    let output = "Based on the knowledge base:\n\n";
    let totalTokens = estimateTokens(output);
    
    for (const result of results) {
      const chunkTokens = estimateTokens(result.chunk.chunkText);
      
      if (totalTokens + chunkTokens > maxTokens) {
        // Truncate to fit
        const remainingTokens = maxTokens - totalTokens - 10;
        if (remainingTokens > 50) {
          const truncatedChars = remainingTokens * 4;
          output += `• ${result.chunk.chunkText.substring(0, truncatedChars)}...\n`;
        }
        break;
      }
      
      output += `• ${result.chunk.chunkText}\n\n`;
      totalTokens += chunkTokens + 5;
    }
    
    return output.trim();
  }
  
  /**
   * Delete all chunks for a knowledge base item
   */
  static async deleteKnowledgeChunks(knowledgeBaseId: string, userId: string): Promise<void> {
    // Get total size of chunks being deleted
    const chunks = await db
      .select()
      .from(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.knowledgeBaseId, knowledgeBaseId),
          eq(knowledgeChunks.userId, userId)
        )
      );
    
    const totalSize = chunks.reduce((sum, chunk) => {
      return sum + Buffer.byteLength(chunk.chunkText, 'utf8');
    }, 0);
    
    // Delete chunks
    await db
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledgeBaseId, knowledgeBaseId));
    
    // Delete processing queue entries
    await db
      .delete(knowledgeProcessingQueue)
      .where(eq(knowledgeProcessingQueue.knowledgeBaseId, knowledgeBaseId));
    
    // Update storage used (subtract deleted size)
    if (totalSize > 0) {
      await this.updateUsedStorage(userId, -totalSize);
    }
    
    logger.info(`[RAG] Deleted ${chunks.length} chunks for knowledge base ${knowledgeBaseId}`);
  }
  
  /**
   * Get processing status for a knowledge base item
   */
  static async getProcessingStatus(knowledgeBaseId: string): Promise<{
    status: string;
    progress: number;
    error?: string;
  } | null> {
    const [entry] = await db
      .select()
      .from(knowledgeProcessingQueue)
      .where(eq(knowledgeProcessingQueue.knowledgeBaseId, knowledgeBaseId))
      .orderBy(sql`${knowledgeProcessingQueue.createdAt} DESC`)
      .limit(1);
    
    if (!entry) {
      return null;
    }
    
    const progress = entry.totalChunks 
      ? (entry.processedChunks || 0) / entry.totalChunks * 100 
      : 0;
    
    return {
      status: entry.status,
      progress: Math.round(progress),
      error: entry.errorMessage || undefined,
    };
  }
  
  /**
   * Get chunk count for a knowledge base item
   */
  static async getChunkCount(knowledgeBaseId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledgeBaseId, knowledgeBaseId));
    
    return Number(result[0]?.count || 0);
  }
}

export default RAGKnowledgeService;
