/**
 * Drizzle store for the brand voice profile. Every query filters on company_id first. The upsert conflicts on
 * (company_id, chatbot_id) only, so one tenant's write cannot replace another tenant's row.
 *
 * Table: brand-voice-schema.ts (in this folder, see its header for the move request).
 */
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { chatbotCommerceBrandVoice } from "./brand-voice-schema.ts";
import type { BrandVoiceProfile, BrandVoiceStore } from "./brand-voice.ts";

export type BrandVoiceDb = NodePgDatabase<Record<string, never>>;

type BrandVoiceRow = typeof chatbotCommerceBrandVoice.$inferSelect;

function fromRow(row: BrandVoiceRow): BrandVoiceProfile {
  return {
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    name: row.name,
    tone: row.tone,
    locale: row.locale,
    preferredTerms: stringArray(row.preferredTerms),
    forbiddenTerms: stringArray(row.forbiddenTerms),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function createDrizzleBrandVoiceStore(db: BrandVoiceDb): BrandVoiceStore {
  const t = chatbotCommerceBrandVoice;
  return {
    async find(companyId, chatbotId) {
      const [row] = await db
        .select()
        .from(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId)))
        .limit(1);
      return row ? fromRow(row) : null;
    },

    async upsert(profile) {
      await db
        .insert(t)
        .values({
          companyId: profile.companyId,
          chatbotId: profile.chatbotId,
          name: profile.name,
          tone: profile.tone,
          locale: profile.locale,
          preferredTerms: profile.preferredTerms,
          forbiddenTerms: profile.forbiddenTerms,
          updatedBy: profile.updatedBy,
          updatedAt: profile.updatedAt,
        })
        .onConflictDoUpdate({
          target: [t.companyId, t.chatbotId],
          set: {
            name: profile.name,
            tone: profile.tone,
            locale: profile.locale,
            preferredTerms: profile.preferredTerms,
            forbiddenTerms: profile.forbiddenTerms,
            updatedBy: profile.updatedBy,
            updatedAt: profile.updatedAt,
          },
        });
    },

    async remove(companyId, chatbotId) {
      const removed = await db
        .delete(t)
        .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId)))
        .returning({ chatbotId: t.chatbotId });
      return removed.length > 0;
    },
  };
}
