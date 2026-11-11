/** Webhook CRUD, logs, test and retry routes. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { getCompanyScope } from "../../middleware/company-scope";
import { webhooks, createWebhookSchema, webhookLogs } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { webhookDeliveryService } from "../../services/webhook-delivery";
import { companyForRead, WEBHOOK_EDITABLE_FIELDS, pickEditableFields } from "./shared";
import { webhookInsertRow } from "./insert-rows";
import { logger } from '../../utils/logger.ts';

export function registerWebhookRoutes(router: Router): void {
  router.get("/webhooks", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;

      const companyId = companyForRead(req, res);
      if (!companyId) return;

      const userWebhooks = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.userId, userId), eq(webhooks.companyId, companyId)))
        .orderBy(desc(webhooks.createdAt));

      res.json(userWebhooks);
    } catch (error: any) {
      logger.error("Error fetching webhooks:", error);
      res.status(500).json({ error: "Failed to fetch webhooks" });
    }
  });

  router.post("/webhooks", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const validatedData = createWebhookSchema.parse(req.body);

      let companyId: string;
      try {
        companyId = getCompanyScope(req);
      } catch {
        return res.status(403).json({ error: "Company scope required" });
      }

      const webhookId = nanoid();
      const [newWebhook] = await db
        .insert(webhooks)
        .values(webhookInsertRow({
          id: webhookId,
          userId,
          ...validatedData,
          companyId,
        }))
        .returning();

      res.json(newWebhook);
    } catch (error: any) {
      logger.error("Error creating webhook:", error);
      res.status(500).json({ error: "Failed to create webhook" });
    }
  });

  router.patch("/webhooks/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const { id } = req.params;

      const editable = pickEditableFields(req.body, WEBHOOK_EDITABLE_FIELDS);
      if (!editable) {
        return res.status(400).json({ error: "No editable fields in request body" });
      }

      const [updatedWebhook] = await db
        .update(webhooks)
        .set({
          ...editable,
          updatedAt: new Date(),
        })
        .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
        .returning();

      if (!updatedWebhook) {
        return res.status(404).json({ error: "Webhook not found" });
      }

      res.json(updatedWebhook);
    } catch (error: any) {
      logger.error("Error updating webhook:", error);
      res.status(500).json({ error: "Failed to update webhook" });
    }
  });

  router.delete("/webhooks/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const { id } = req.params;

      await db
        .delete(webhooks)
        .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)));

      res.json({ success: true });
    } catch (error: any) {
      logger.error("Error deleting webhook:", error);
      res.status(500).json({ error: "Failed to delete webhook" });
    }
  });

  router.get("/webhooks/:id/logs", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;
      const limit = parseInt(req.query.limit as string, 10) || 50;

      const [webhook] = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId), eq(webhooks.companyId, companyId)));

      if (!webhook) {
        return res.status(404).json({ error: "Webhook not found" });
      }

      const logs = await db
        .select()
        .from(webhookLogs)
        .where(and(eq(webhookLogs.webhookId, id), eq(webhookLogs.companyId, companyId)))
        .orderBy(desc(webhookLogs.createdAt))
        .limit(limit);

      res.json(logs);
    } catch (error: any) {
      logger.error("Error fetching webhook logs:", error);
      res.status(500).json({ error: "Failed to fetch webhook logs" });
    }
  });

  router.post("/webhooks/:id/test", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      const [owned] = await db
        .select({ id: webhooks.id })
        .from(webhooks)
        .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId), eq(webhooks.companyId, companyId)));
      if (!owned) {
        return res.status(404).json({ error: "Webhook not found" });
      }

      const result = await webhookDeliveryService.testWebhook(companyId, id, userId);

      res.json(result);
    } catch (error: any) {
      logger.error("Error testing webhook:", error);
      res.status(500).json({ error: "Failed to test webhook" });
    }
  });

  router.post("/webhooks/logs/:logId/retry", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { logId } = req.params;

      const [ownedLog] = await db
        .select({ id: webhookLogs.id })
        .from(webhookLogs)
        .where(and(eq(webhookLogs.id, parseInt(logId, 10)), eq(webhookLogs.companyId, companyId)));
      if (!ownedLog) {
        return res.status(404).json({ error: "Webhook log not found" });
      }

      const result = await webhookDeliveryService.retryWebhook(companyId, parseInt(logId, 10), userId);

      res.json(result);
    } catch (error: any) {
      logger.error("Error retrying webhook:", error);
      res.status(500).json({ error: "Failed to retry webhook" });
    }
  });
}
