import type { Express, Response } from "express";
import { storage } from "../../storage";
import { db } from "../../db";
import { phoneNumbers, knowledgeBase } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { authenticateToken, type AuthRequest } from "../../middleware/auth";
import { flows } from "@shared/schema";
import { logger } from "../../utils/logger";

export function registerUserLimitsRoutes(app: Express): void {
  // ============================================
  // USER LIMITS API
  // ============================================

  // Get all user limits and current usage
  app.get("/api/user/limits", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const limits = await storage.getUserEffectiveLimits(req.userId!);

      // Get current counts
      const webhookCount = await storage.getUserWebhookCount(req.userId!);
      const kbCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeBase)
        .where(eq(knowledgeBase.userId, req.userId!));
      const flowCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(flows)
        .where(eq(flows.userId, req.userId!));
      const phoneCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(phoneNumbers)
        .where(eq(phoneNumbers.userId, req.userId!));

      res.json({
        webhooks: {
          current: webhookCount,
          max: limits.maxWebhooks,
          remaining: Math.max(0, limits.maxWebhooks - webhookCount),
          source: limits.sources.maxWebhooks
        },
        knowledgeBases: {
          current: Number(kbCount[0]?.count || 0),
          max: limits.maxKnowledgeBases,
          remaining: Math.max(0, limits.maxKnowledgeBases - Number(kbCount[0]?.count || 0)),
          source: limits.sources.maxKnowledgeBases
        },
        flows: {
          current: Number(flowCount[0]?.count || 0),
          max: limits.maxFlows,
          remaining: Math.max(0, limits.maxFlows - Number(flowCount[0]?.count || 0)),
          source: limits.sources.maxFlows
        },
        phoneNumbers: {
          current: Number(phoneCount[0]?.count || 0),
          max: limits.maxPhoneNumbers,
          remaining: Math.max(0, limits.maxPhoneNumbers - Number(phoneCount[0]?.count || 0)),
          source: limits.sources.maxPhoneNumbers
        }
      });
    } catch (error: any) {
      logger.error("Get user limits error:", error);
      res.status(500).json({ error: "Failed to get user limits" });
    }
  });
}
