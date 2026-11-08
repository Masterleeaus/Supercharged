/** Flow template listing, template clone and flow clone routes. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { flows } from "@shared/schema";
import { eq, and, or, sql, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { flowTemplates } from "../../services/flow-templates";
import { storage } from "../../storage";
import { companyForRead } from "./shared";

export function registerFlowTemplateRoutes(router: Router): void {
  router.get("/flow-templates", async (req: AuthRequest, res: Response) => {
    try {
      const templates = flowTemplates.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        isTemplate: template.isTemplate,
        nodeCount: template.nodes.length,
        preview: template.nodes.slice(0, 3).map((n) => n.type),
      }));

      res.json(templates);
    } catch (error: any) {
      console.error("Error fetching templates:", error);
      res.status(500).json({ error: "Failed to fetch templates" });
    }
  });

  router.post("/flow-templates/:templateId/clone", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { templateId } = req.params;
      const { name } = req.body;

      // Enforce flow limit before cloning
      const effectiveLimits = await storage.getUserEffectiveLimits(userId);
      const currentFlowCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(flows)
        .where(and(eq(flows.userId, userId), eq(flows.companyId, companyId)));
      const flowCount = Number(currentFlowCount[0]?.count || 0);
      const maxFlows = typeof effectiveLimits.maxFlows === 'number' ? effectiveLimits.maxFlows : 3;
      if (maxFlows !== 999 && maxFlows !== -1 && flowCount >= maxFlows) {
        return res.status(403).json({
          error: "Flow limit reached",
          message: `You have reached your maximum of ${maxFlows} flows. Please upgrade your plan or delete existing flows.`,
          limit: maxFlows,
          current: flowCount
        });
      }

      const template = flowTemplates.find((t) => t.id === templateId);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }

      const newFlowId = nanoid();
      const now = new Date();
      // TODO: Drizzle type inference - template nodes/edges are typed but Drizzle insert expects exact match
      const [newFlow] = await db
        .insert(flows)
        .values({
          id: newFlowId,
          userId,
          companyId,
          name: name || template.name,
          description: template.description || null,
          nodes: template.nodes,
          edges: template.edges,
          isActive: false,
          isTemplate: false,
          createdAt: now,
          updatedAt: now,
        } as typeof flows.$inferInsert)
        .returning();

      res.json(newFlow);
    } catch (error: any) {
      console.error("Error cloning template:", error);
      res.status(500).json({ error: "Failed to clone template" });
    }
  });

  router.post("/flows/:id/clone", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      // Enforce flow limit before cloning
      const effectiveLimits = await storage.getUserEffectiveLimits(userId);
      const currentFlowCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(flows)
        .where(and(eq(flows.userId, userId), eq(flows.companyId, companyId)));
      const flowCount = Number(currentFlowCount[0]?.count || 0);
      const maxFlows = typeof effectiveLimits.maxFlows === 'number' ? effectiveLimits.maxFlows : 3;
      if (maxFlows !== 999 && maxFlows !== -1 && flowCount >= maxFlows) {
        return res.status(403).json({
          error: "Flow limit reached",
          message: `You have reached your maximum of ${maxFlows} flows. Please upgrade your plan or delete existing flows.`,
          limit: maxFlows,
          current: flowCount
        });
      }

      const [originalFlow] = await db
        .select()
        .from(flows)
        .where(and(
          eq(flows.id, id),
          or(
            and(eq(flows.userId, userId), eq(flows.companyId, companyId)),
            and(eq(flows.isTemplate, true), or(isNull(flows.companyId), eq(flows.companyId, companyId)))
          )
        ));

      if (!originalFlow) {
        return res.status(404).json({ error: "Flow not found" });
      }

      const newFlowId = nanoid();
      const [clonedFlow] = await db
        .insert(flows)
        .values({
          id: newFlowId,
          userId,
          companyId,
          name: `${originalFlow.name} (Copy)`,
          description: originalFlow.description,
          nodes: originalFlow.nodes,
          edges: originalFlow.edges,
          isActive: false,
          isTemplate: false,
        })
        .returning();

      res.json(clonedFlow);
    } catch (error: any) {
      console.error("Error cloning flow:", error);
      res.status(500).json({ error: "Failed to clone flow" });
    }
  });
}
