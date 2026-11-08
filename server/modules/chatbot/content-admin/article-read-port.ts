/**
 * Read port for the knowledge agent: the articles one chatbot may use, from this module's article table.
 *
 * The knowledge agent codes against ArticleReadPort. It does not own the table and does not write it.
 * Only articles of the requested company that are linked to the requested chatbot, and that have content, are
 * returned. Featured articles come first, then title order.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import type { ContentAdminStorage } from "./types.ts";

export interface ChatbotArticle {
  id: string;
  title: string;
  description: string;
  content: string;
  isFeatured: boolean;
  updatedAt: Date;
}

export interface ArticleReadPort {
  listForChatbot(companyId: string, chatbotId: string): Promise<ChatbotArticle[]>;
}

export type ArticleListSource = Pick<ContentAdminStorage, "listArticles">;

export function createArticleReadPort(storage: ArticleListSource): ArticleReadPort {
  return {
    async listForChatbot(companyId, chatbotId) {
      const cid = requireCompanyId(companyId);
      if (!chatbotId) return [];
      const rows = await storage.listArticles(cid);
      return rows
        .filter(
          (row) =>
            row.companyId === cid &&
            row.chatbotIds.includes(chatbotId) &&
            typeof row.content === "string" &&
            row.content.trim().length > 0,
        )
        .sort(
          (a, b) =>
            Number(b.isFeatured) - Number(a.isFeatured) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
        )
        .map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          content: row.content as string,
          isFeatured: row.isFeatured,
          updatedAt: row.updatedAt,
        }));
    },
  };
}
