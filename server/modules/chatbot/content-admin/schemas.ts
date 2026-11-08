/**
 * Input schemas for the content admin routes. Every object is .strict(), so a companyId or userId in a body
 * is rejected with 400, never dropped. Tenancy comes from the router, not from the body.
 *
 * Limits: title 255 (matches the column), description 1000, canned content 10000, article content 50000,
 * at most 50 chatbot links per article. Core has no limits here; these are the port's choice (see DECISIONS.md).
 */
import { z } from "zod";
import { ANALYTICS_METRICS } from "../contracts/index.ts";

export const CONTENT_LIMITS = {
  title: 255,
  description: 1000,
  cannedContent: 10000,
  articleContent: 50000,
  chatbotLinks: 50,
  idLength: 64,
  maxRangeDays: 366,
} as const;

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const idField = z.string().trim().min(1).max(CONTENT_LIMITS.idLength).regex(/^[A-Za-z0-9_-]+$/);

export const contentIdParam = idField;

export const cannedCreateSchema = z
  .object({
    title: trimmed(CONTENT_LIMITS.title),
    content: trimmed(CONTENT_LIMITS.cannedContent),
  })
  .strict();

export const cannedUpdateSchema = cannedCreateSchema.partial().strict().refine((v) => Object.keys(v).length > 0, {
  message: "at least one field is required",
});

export const articleCreateSchema = z
  .object({
    title: trimmed(CONTENT_LIMITS.title),
    description: trimmed(CONTENT_LIMITS.description),
    content: z.string().max(CONTENT_LIMITS.articleContent).nullable().optional().transform((v) => v ?? null),
    isFeatured: z.boolean().optional().transform((v) => v ?? false),
    chatbotIds: z
      .array(idField)
      .max(CONTENT_LIMITS.chatbotLinks)
      .optional()
      .transform((v) => Array.from(new Set(v ?? []))),
  })
  .strict();

export const articleUpdateSchema = articleCreateSchema.partial().strict().refine((v) => Object.keys(v).length > 0, {
  message: "at least one field is required",
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "invalid date");

/** Query for GET /analytics/summary. Dates are UTC calendar days, inclusive. */
export const analyticsQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    chatbotId: idField.optional(),
    groupBy: z.enum(["day", "week", "channel", "chatbot"]).optional(),
    metrics: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [...ANALYTICS_METRICS]))
      .pipe(z.array(z.enum(ANALYTICS_METRICS)).min(1).max(ANALYTICS_METRICS.length)),
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: "from must be on or before to", path: ["to"] })
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < CONTENT_LIMITS.maxRangeDays,
    { message: "range is longer than the limit", path: ["to"] },
  );

export type CannedCreateInput = z.infer<typeof cannedCreateSchema>;
export type CannedUpdateInput = z.infer<typeof cannedUpdateSchema>;
export type ArticleCreateInput = z.infer<typeof articleCreateSchema>;
export type ArticleUpdateInput = z.infer<typeof articleUpdateSchema>;
export type AnalyticsQueryInput = z.infer<typeof analyticsQuerySchema>;
