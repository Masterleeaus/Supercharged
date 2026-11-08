import type { Express, Response } from "express";
import { storage } from "../../storage";
import { db } from "../../db";
import { phoneNumbers, llmModels, knowledgeBase, userSubscriptions } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { authenticateToken, requireRole, type AuthRequest } from "../../middleware/auth";
import { flows } from "@shared/schema";
import { safeErrorMessage } from "../../utils/safe-error";

export function registerAdminUserRoutes(app: Express): void {
  // LLM Models - Get available models for current user (filtered by plan tier)
  app.get("/api/llm-models/available", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const { llmModels } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      // Get user to check their plan tier
      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Fetch all active models
      const allModels = await db
        .select()
        .from(llmModels)
        .where(eq(llmModels.isActive, true))
        .orderBy(llmModels.sortOrder, llmModels.name);

      // Admins and Pro users can see all models
      if (user.role === 'admin' || user.planType === 'pro') {
        return res.json(allModels);
      }

      // Free users can only see free tier models
      const freeModels = allModels.filter(model => model.tier === 'free');
      res.json(freeModels);
    } catch (error: any) {
      console.error("Get available LLM models error:", error);
      res.status(500).json({ error: "Failed to get available LLM models" });
    }
  });

  app.post("/api/admin/users/:id/credits", authenticateToken, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
    try {
      const { amount, description } = req.body;

      if (typeof amount !== "number") {
        return res.status(400).json({ error: "Amount is required and must be a number" });
      }

      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const newCredits = user.credits + amount;
      await storage.updateUserCredits(user.id, newCredits);

      await storage.createCreditTransaction({
        userId: user.id,
        type: amount > 0 ? "credit" : "debit",
        amount,
        description: description || (amount > 0 ? "Credit added by admin" : "Credit deducted by admin"),
        reference: null,
        stripePaymentId: null,
      });

      res.json({ success: true, newCredits });
    } catch (error: any) {
      console.error("Update user credits error:", error);
      res.status(500).json({ error: "Failed to update user credits" });
    }
  });

  // Admin: Get user's effective limits and overrides
  app.get("/api/admin/users/:id/limits", authenticateToken, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const limits = await storage.getUserEffectiveLimits(req.params.id);

      // Get subscription overrides if any
      const subscription = await storage.getUserSubscription(req.params.id);

      // Get current usage counts
      const webhookCount = await storage.getUserWebhookCount(req.params.id);
      const kbCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeBase)
        .where(eq(knowledgeBase.userId, req.params.id));
      const flowCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(flows)
        .where(eq(flows.userId, req.params.id));
      const phoneCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(phoneNumbers)
        .where(eq(phoneNumbers.userId, req.params.id));

      res.json({
        userId: req.params.id,
        effectiveLimits: limits,
        overrides: subscription ? {
          overrideMaxWebhooks: subscription.overrideMaxWebhooks,
          overrideMaxKnowledgeBases: subscription.overrideMaxKnowledgeBases,
          overrideMaxFlows: subscription.overrideMaxFlows,
          overrideMaxPhoneNumbers: subscription.overrideMaxPhoneNumbers
        } : null,
        currentUsage: {
          webhooks: webhookCount,
          knowledgeBases: Number(kbCount[0]?.count || 0),
          flows: Number(flowCount[0]?.count || 0),
          phoneNumbers: Number(phoneCount[0]?.count || 0)
        }
      });
    } catch (error: any) {
      console.error("Get user limits error:", error);
      res.status(500).json({ error: "Failed to get user limits" });
    }
  });

  // Admin: Update user's limit overrides
  app.patch("/api/admin/users/:id/limits", authenticateToken, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const body = req.body;

      // Coerce and validate limit values: accept null, undefined (no change), or valid integers
      // Empty strings and "null" strings are coerced to null for convenience
      const coerceAndValidate = (value: any, name: string): number | null | undefined => {
        // undefined means don't change existing value
        if (value === undefined) return undefined;
        // null, empty string, or "null" string means inherit from plan
        if (value === null || value === '' || value === 'null') return null;
        // Coerce string numbers to integers
        const numValue = typeof value === 'string' ? parseInt(value, 10) : value;
        if (typeof numValue !== 'number' || isNaN(numValue) || numValue < 0 || !Number.isInteger(numValue)) {
          throw new Error(`${name} must be null (inherit from plan) or a non-negative integer (use 999 for unlimited)`);
        }
        return numValue;
      };

      const overrideMaxWebhooks = coerceAndValidate(body.overrideMaxWebhooks, 'overrideMaxWebhooks');
      const overrideMaxKnowledgeBases = coerceAndValidate(body.overrideMaxKnowledgeBases, 'overrideMaxKnowledgeBases');
      const overrideMaxFlows = coerceAndValidate(body.overrideMaxFlows, 'overrideMaxFlows');
      const overrideMaxPhoneNumbers = coerceAndValidate(body.overrideMaxPhoneNumbers, 'overrideMaxPhoneNumbers');

      // Get or create subscription
      let subscription = await storage.getUserSubscription(req.params.id);

      if (!subscription) {
        // Create a free subscription with overrides
        subscription = await storage.createUserSubscription({
          userId: req.params.id,
          planId: 'free',
          status: 'active',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
          overrideMaxWebhooks: overrideMaxWebhooks ?? null,
          overrideMaxKnowledgeBases: overrideMaxKnowledgeBases ?? null,
          overrideMaxFlows: overrideMaxFlows ?? null,
          overrideMaxPhoneNumbers: overrideMaxPhoneNumbers ?? null
        });
      } else {
        // Update existing subscription with new overrides
        await db.update(userSubscriptions)
          .set({
            overrideMaxWebhooks: overrideMaxWebhooks !== undefined ? overrideMaxWebhooks : subscription.overrideMaxWebhooks,
            overrideMaxKnowledgeBases: overrideMaxKnowledgeBases !== undefined ? overrideMaxKnowledgeBases : subscription.overrideMaxKnowledgeBases,
            overrideMaxFlows: overrideMaxFlows !== undefined ? overrideMaxFlows : subscription.overrideMaxFlows,
            overrideMaxPhoneNumbers: overrideMaxPhoneNumbers !== undefined ? overrideMaxPhoneNumbers : subscription.overrideMaxPhoneNumbers
          })
          .where(eq(userSubscriptions.id, subscription.id));
      }

      // Return updated limits
      const newLimits = await storage.getUserEffectiveLimits(req.params.id);
      res.json({ success: true, effectiveLimits: newLimits });
    } catch (error: any) {
      console.error("Update user limits error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to update user limits") });
    }
  });

  // Admin: Reset user's limit overrides to plan defaults
  app.delete("/api/admin/users/:id/limits", authenticateToken, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const subscription = await storage.getUserSubscription(req.params.id);

      if (subscription) {
        // Reset all overrides to null (inherit from plan)
        await db.update(userSubscriptions)
          .set({
            overrideMaxWebhooks: null,
            overrideMaxKnowledgeBases: null,
            overrideMaxFlows: null,
            overrideMaxPhoneNumbers: null
          })
          .where(eq(userSubscriptions.id, subscription.id));
      }

      // Return updated limits
      const newLimits = await storage.getUserEffectiveLimits(req.params.id);
      res.json({ success: true, effectiveLimits: newLimits, message: "User limits reset to plan defaults" });
    } catch (error: any) {
      console.error("Reset user limits error:", error);
      res.status(500).json({ error: "Failed to reset user limits" });
    }
  });
}
