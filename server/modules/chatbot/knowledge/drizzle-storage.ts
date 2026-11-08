/**
 * Drizzle implementation of KnowledgeStorage and the retrieval candidate reader. Tables are in
 * db/knowledge.ts. Every query filters on company_id, and every join carries company_id as well.
 *
 * replaceChunks and deleteSource run in one transaction. The same rules are in memory-storage.ts.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  type Embedding,
  type KnowledgeChunk,
  type KnowledgeSource,
  type KnowledgeSourceStatus,
  type KnowledgeStorage,
  type NewKnowledgeSource,
} from "../contracts/index.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import {
  chatbotKnowledgeChunks,
  chatbotKnowledgeEmbeddings,
  chatbotKnowledgeSources,
  KNOWLEDGE_CONSTRAINTS,
} from "../db/knowledge.ts";
import { chunkIdFor } from "./chunking.ts";
import { type EmbeddingModel } from "./embedding.ts";
import { KnowledgeError } from "./errors.ts";
import { type EmbeddedCandidate, type KnowledgeCandidateReader } from "./retriever.ts";

type Db = PgDatabase<any, any, any>;

type SourceRow = typeof chatbotKnowledgeSources.$inferSelect;

function toSource(row: SourceRow): KnowledgeSource {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    kind: row.kind as KnowledgeSource["kind"],
    title: row.title,
    uri: row.uri,
    status: row.status as KnowledgeSourceStatus,
    contentHash: row.contentHash,
    lastIndexedAt: row.lastIndexedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Maps a Postgres unique violation on the source uri to a conflict, and anything else passes through. */
export function mapKnowledgeDatabaseError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  if (code === "23505" && constraint === KNOWLEDGE_CONSTRAINTS.sourceUri) {
    return new KnowledgeError("conflict", "A source with this address already exists.", 409);
  }
  return error;
}

export class DrizzleKnowledgeStorage implements KnowledgeStorage, KnowledgeCandidateReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async insertSource(companyId: string, input: NewKnowledgeSource): Promise<KnowledgeSource> {
    const tenant = requireCompanyId(companyId);
    try {
      const [row] = await this.db
        .insert(chatbotKnowledgeSources)
        .values({
          companyId: tenant,
          id: randomUUID(),
          chatbotId: input.chatbotId,
          kind: input.kind,
          title: input.title,
          uri: input.uri,
          status: "pending",
        })
        .returning();
      return toSource(row);
    } catch (error) {
      throw mapKnowledgeDatabaseError(error);
    }
  }

  async getSource(companyId: string, sourceId: string): Promise<KnowledgeSource | null> {
    const tenant = requireCompanyId(companyId);
    const [row] = await this.db
      .select()
      .from(chatbotKnowledgeSources)
      .where(and(eq(chatbotKnowledgeSources.companyId, tenant), eq(chatbotKnowledgeSources.id, sourceId)))
      .limit(1);
    return row ? toSource(row) : null;
  }

  async listSources(companyId: string, chatbotId: string): Promise<KnowledgeSource[]> {
    const tenant = requireCompanyId(companyId);
    const rows = await this.db
      .select()
      .from(chatbotKnowledgeSources)
      .where(and(eq(chatbotKnowledgeSources.companyId, tenant), eq(chatbotKnowledgeSources.chatbotId, chatbotId)))
      .orderBy(asc(chatbotKnowledgeSources.createdAt), asc(chatbotKnowledgeSources.id));
    return rows.map(toSource);
  }

  async setSourceStatus(
    companyId: string,
    sourceId: string,
    status: KnowledgeSourceStatus,
    detail: { contentHash?: string; lastError?: string | null; lastIndexedAt?: Date },
  ): Promise<KnowledgeSource | null> {
    const tenant = requireCompanyId(companyId);
    const patch: Partial<typeof chatbotKnowledgeSources.$inferInsert> = { status, updatedAt: new Date() };
    if (detail.contentHash !== undefined) patch.contentHash = detail.contentHash;
    if (detail.lastError !== undefined) patch.lastError = detail.lastError;
    if (detail.lastIndexedAt !== undefined) patch.lastIndexedAt = detail.lastIndexedAt;
    const [row] = await this.db
      .update(chatbotKnowledgeSources)
      .set(patch)
      .where(and(eq(chatbotKnowledgeSources.companyId, tenant), eq(chatbotKnowledgeSources.id, sourceId)))
      .returning();
    return row ? toSource(row) : null;
  }

  async replaceChunks(
    companyId: string,
    sourceId: string,
    chunks: Omit<KnowledgeChunk, "id" | "createdAt">[],
    embeddings: Omit<Embedding, "createdAt">[],
  ): Promise<number> {
    const tenant = requireCompanyId(companyId);
    return this.db.transaction(async (tx) => {
      const [source] = await tx
        .select({ chatbotId: chatbotKnowledgeSources.chatbotId })
        .from(chatbotKnowledgeSources)
        .where(and(eq(chatbotKnowledgeSources.companyId, tenant), eq(chatbotKnowledgeSources.id, sourceId)))
        .limit(1);
      if (!source) return 0;

      const ids = new Set<string>();
      const rows = chunks.map((c) => {
        if (c.companyId !== tenant || c.sourceId !== sourceId || c.chatbotId !== source.chatbotId) {
          throw new KnowledgeError("write_failed", "A chunk does not belong to this source.");
        }
        const id = chunkIdFor(sourceId, c.ordinal, c.contentHash);
        ids.add(id);
        return {
          companyId: tenant,
          id,
          sourceId,
          chatbotId: source.chatbotId,
          ordinal: c.ordinal,
          text: c.text,
          tokenCount: c.tokenCount,
          contentHash: c.contentHash,
          metadata: c.metadata,
        };
      });
      const embeddingRows = embeddings.map((e) => {
        if (e.companyId !== tenant || !ids.has(e.chunkId)) {
          throw new KnowledgeError("write_failed", "An embedding does not match a chunk of this source.");
        }
        if (e.vector.length !== e.dimensions) {
          throw new KnowledgeError("write_failed", "An embedding length does not match its dimensions.");
        }
        return {
          companyId: tenant,
          chunkId: e.chunkId,
          provider: e.provider,
          model: e.model,
          dimensions: e.dimensions,
          vector: e.vector,
        };
      });

      const oldIds = await tx
        .select({ id: chatbotKnowledgeChunks.id })
        .from(chatbotKnowledgeChunks)
        .where(and(eq(chatbotKnowledgeChunks.companyId, tenant), eq(chatbotKnowledgeChunks.sourceId, sourceId)));
      if (oldIds.length > 0) {
        await tx
          .delete(chatbotKnowledgeEmbeddings)
          .where(
            and(
              eq(chatbotKnowledgeEmbeddings.companyId, tenant),
              inArray(chatbotKnowledgeEmbeddings.chunkId, oldIds.map((r) => r.id)),
            ),
          );
      }
      await tx
        .delete(chatbotKnowledgeChunks)
        .where(and(eq(chatbotKnowledgeChunks.companyId, tenant), eq(chatbotKnowledgeChunks.sourceId, sourceId)));

      if (rows.length > 0) await tx.insert(chatbotKnowledgeChunks).values(rows);
      if (embeddingRows.length > 0) await tx.insert(chatbotKnowledgeEmbeddings).values(embeddingRows);
      return rows.length;
    });
  }

  async deleteSource(companyId: string, sourceId: string): Promise<boolean> {
    const tenant = requireCompanyId(companyId);
    return this.db.transaction(async (tx) => {
      const chunkIds = await tx
        .select({ id: chatbotKnowledgeChunks.id })
        .from(chatbotKnowledgeChunks)
        .where(and(eq(chatbotKnowledgeChunks.companyId, tenant), eq(chatbotKnowledgeChunks.sourceId, sourceId)));
      if (chunkIds.length > 0) {
        await tx
          .delete(chatbotKnowledgeEmbeddings)
          .where(
            and(
              eq(chatbotKnowledgeEmbeddings.companyId, tenant),
              inArray(chatbotKnowledgeEmbeddings.chunkId, chunkIds.map((r) => r.id)),
            ),
          );
      }
      await tx
        .delete(chatbotKnowledgeChunks)
        .where(and(eq(chatbotKnowledgeChunks.companyId, tenant), eq(chatbotKnowledgeChunks.sourceId, sourceId)));
      const deleted = await tx
        .delete(chatbotKnowledgeSources)
        .where(and(eq(chatbotKnowledgeSources.companyId, tenant), eq(chatbotKnowledgeSources.id, sourceId)))
        .returning({ id: chatbotKnowledgeSources.id });
      return deleted.length > 0;
    });
  }

  async listCandidates(
    companyId: string,
    chatbotId: string,
    model: EmbeddingModel,
    sourceIds?: readonly string[],
  ): Promise<EmbeddedCandidate[]> {
    const tenant = requireCompanyId(companyId);
    const conditions = [
      eq(chatbotKnowledgeEmbeddings.companyId, tenant),
      eq(chatbotKnowledgeChunks.chatbotId, chatbotId),
      eq(chatbotKnowledgeSources.status, "ready"),
      eq(chatbotKnowledgeEmbeddings.provider, model.provider),
      eq(chatbotKnowledgeEmbeddings.model, model.model),
      eq(chatbotKnowledgeEmbeddings.dimensions, model.dimensions),
    ];
    if (sourceIds) conditions.push(inArray(chatbotKnowledgeChunks.sourceId, [...sourceIds]));

    const rows = await this.db
      .select({
        chunkId: chatbotKnowledgeChunks.id,
        sourceId: chatbotKnowledgeChunks.sourceId,
        sourceTitle: chatbotKnowledgeSources.title,
        ordinal: chatbotKnowledgeChunks.ordinal,
        text: chatbotKnowledgeChunks.text,
        vector: chatbotKnowledgeEmbeddings.vector,
      })
      .from(chatbotKnowledgeEmbeddings)
      .innerJoin(
        chatbotKnowledgeChunks,
        and(
          eq(chatbotKnowledgeChunks.companyId, chatbotKnowledgeEmbeddings.companyId),
          eq(chatbotKnowledgeChunks.id, chatbotKnowledgeEmbeddings.chunkId),
        ),
      )
      .innerJoin(
        chatbotKnowledgeSources,
        and(
          eq(chatbotKnowledgeSources.companyId, chatbotKnowledgeChunks.companyId),
          eq(chatbotKnowledgeSources.id, chatbotKnowledgeChunks.sourceId),
        ),
      )
      .where(and(...conditions));

    return rows.map((row) => ({
      companyId: tenant,
      chunkId: row.chunkId,
      sourceId: row.sourceId,
      sourceTitle: row.sourceTitle,
      ordinal: row.ordinal,
      text: row.text,
      vector: row.vector,
    }));
  }
}
