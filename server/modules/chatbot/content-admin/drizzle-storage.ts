/**
 * Drizzle ContentAdminStorage over server/modules/chatbot/db/content.ts. Every query filters on company_id.
 * Not wired into any app yet: the owner passes a db handle when the routes are mounted (see DECISIONS.md).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { chatbots } from "../../../../shared/schema.ts";
import {
  chatbotCannedResponses,
  chatbotKnowledgeBaseArticleLinks,
  chatbotKnowledgeBaseArticles,
  type ChatbotCannedResponseRow,
  type ChatbotKnowledgeBaseArticleRow,
} from "../db/content.ts";
import type {
  ArticlePatch,
  CannedResponse,
  CannedResponsePatch,
  ContentAdminStorage,
  KnowledgeBaseArticle,
  NewCannedResponse,
  NewKnowledgeBaseArticle,
} from "./types.ts";

type Db = NodePgDatabase<Record<string, unknown>>;

const toCanned = (row: ChatbotCannedResponseRow): CannedResponse => ({
  id: row.id,
  companyId: row.companyId,
  userId: row.userId ?? null,
  title: row.title,
  content: row.content,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toArticle = (row: ChatbotKnowledgeBaseArticleRow, chatbotIds: string[]): KnowledgeBaseArticle => ({
  id: row.id,
  companyId: row.companyId,
  userId: row.userId ?? null,
  title: row.title,
  description: row.description,
  content: row.content ?? null,
  isFeatured: row.isFeatured,
  chatbotIds,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function createDrizzleContentAdminStorage(db: Db): ContentAdminStorage {
  const linkedChatbotIds = async (
    conn: Db,
    companyId: string,
    articleIds: string[],
  ): Promise<Map<string, string[]>> => {
    const out = new Map<string, string[]>();
    if (articleIds.length === 0) return out;
    const links = await conn
      .select()
      .from(chatbotKnowledgeBaseArticleLinks)
      .where(and(eq(chatbotKnowledgeBaseArticleLinks.companyId, companyId), inArray(chatbotKnowledgeBaseArticleLinks.articleId, articleIds)))
      .orderBy(asc(chatbotKnowledgeBaseArticleLinks.createdAt));
    for (const link of links) {
      const list = out.get(link.articleId) ?? [];
      list.push(link.chatbotId);
      out.set(link.articleId, list);
    }
    return out;
  };

  const writeLinks = async (tx: Db, companyId: string, articleId: string, chatbotIds: string[], now: Date) => {
    await tx
      .delete(chatbotKnowledgeBaseArticleLinks)
      .where(and(eq(chatbotKnowledgeBaseArticleLinks.companyId, companyId), eq(chatbotKnowledgeBaseArticleLinks.articleId, articleId)));
    if (chatbotIds.length > 0) {
      await tx.insert(chatbotKnowledgeBaseArticleLinks).values(
        chatbotIds.map((chatbotId) => ({ companyId, articleId, chatbotId, createdAt: now })),
      );
    }
  };

  return {
    async listCannedResponses(companyId) {
      const rows = await db
        .select()
        .from(chatbotCannedResponses)
        .where(eq(chatbotCannedResponses.companyId, companyId))
        .orderBy(asc(chatbotCannedResponses.title), asc(chatbotCannedResponses.id));
      return rows.map(toCanned);
    },
    async findCannedResponse(companyId, id) {
      const [row] = await db
        .select()
        .from(chatbotCannedResponses)
        .where(and(eq(chatbotCannedResponses.companyId, companyId), eq(chatbotCannedResponses.id, id)))
        .limit(1);
      return row ? toCanned(row) : null;
    },
    async insertCannedResponse(companyId, input: NewCannedResponse, userId, now) {
      const [row] = await db
        .insert(chatbotCannedResponses)
        .values({ companyId, userId, title: input.title, content: input.content, createdAt: now, updatedAt: now })
        .returning();
      return toCanned(row);
    },
    async updateCannedResponse(companyId, id, patch: CannedResponsePatch, now) {
      const [row] = await db
        .update(chatbotCannedResponses)
        .set({ ...patch, updatedAt: now })
        .where(and(eq(chatbotCannedResponses.companyId, companyId), eq(chatbotCannedResponses.id, id)))
        .returning();
      return row ? toCanned(row) : null;
    },
    async deleteCannedResponse(companyId, id) {
      const rows = await db
        .delete(chatbotCannedResponses)
        .where(and(eq(chatbotCannedResponses.companyId, companyId), eq(chatbotCannedResponses.id, id)))
        .returning({ id: chatbotCannedResponses.id });
      return rows.length > 0;
    },

    async listArticles(companyId) {
      const rows = await db
        .select()
        .from(chatbotKnowledgeBaseArticles)
        .where(eq(chatbotKnowledgeBaseArticles.companyId, companyId))
        .orderBy(asc(chatbotKnowledgeBaseArticles.title), asc(chatbotKnowledgeBaseArticles.id));
      const links = await linkedChatbotIds(db, companyId, rows.map((r) => r.id));
      return rows.map((r) => toArticle(r, links.get(r.id) ?? []));
    },
    async findArticle(companyId, id) {
      const [row] = await db
        .select()
        .from(chatbotKnowledgeBaseArticles)
        .where(and(eq(chatbotKnowledgeBaseArticles.companyId, companyId), eq(chatbotKnowledgeBaseArticles.id, id)))
        .limit(1);
      if (!row) return null;
      const links = await linkedChatbotIds(db, companyId, [id]);
      return toArticle(row, links.get(id) ?? []);
    },
    async filterOwnChatbotIds(companyId, chatbotIds) {
      if (chatbotIds.length === 0) return [];
      const rows = await db
        .select({ id: chatbots.id })
        .from(chatbots)
        .where(and(eq(chatbots.companyId, companyId), inArray(chatbots.id, chatbotIds)));
      const known = new Set(rows.map((r) => r.id));
      return chatbotIds.filter((id) => known.has(id));
    },
    async insertArticle(companyId, input: NewKnowledgeBaseArticle, userId, now) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(chatbotKnowledgeBaseArticles)
          .values({
            companyId,
            userId,
            title: input.title,
            description: input.description,
            content: input.content,
            isFeatured: input.isFeatured,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await writeLinks(tx as unknown as Db, companyId, row.id, input.chatbotIds, now);
        return toArticle(row, [...input.chatbotIds]);
      });
    },
    async updateArticle(companyId, id, patch: ArticlePatch, now) {
      return db.transaction(async (tx) => {
        const { chatbotIds, ...fields } = patch;
        const [row] = await tx
          .update(chatbotKnowledgeBaseArticles)
          .set({ ...fields, updatedAt: now })
          .where(and(eq(chatbotKnowledgeBaseArticles.companyId, companyId), eq(chatbotKnowledgeBaseArticles.id, id)))
          .returning();
        if (!row) return null;
        if (chatbotIds) await writeLinks(tx as unknown as Db, companyId, id, chatbotIds, now);
        const links = await linkedChatbotIds(tx as unknown as Db, companyId, [id]);
        return toArticle(row, links.get(id) ?? []);
      });
    },
    async deleteArticle(companyId, id) {
      const rows = await db
        .delete(chatbotKnowledgeBaseArticles)
        .where(and(eq(chatbotKnowledgeBaseArticles.companyId, companyId), eq(chatbotKnowledgeBaseArticles.id, id)))
        .returning({ id: chatbotKnowledgeBaseArticles.id });
      return rows.length > 0;
    },
  };
}
