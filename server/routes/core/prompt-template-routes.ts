import type { Express, Response } from "express";
import { storage } from "../../storage";
import { authenticateToken, requireRole, type AuthRequest } from "../../middleware/auth";
import { insertPromptTemplateSchema, promptTemplates } from "@shared/schema";
import { logger } from "../../utils/logger";

// Table insert shape for createPromptTemplate; the drizzle-zod insert type resolves to {}.
type PromptTemplateInsertRow = typeof promptTemplates.$inferInsert & { companyId?: string };

export function registerPromptTemplateRoutes(app: Express): void {
  // ============================================
  // PROMPT TEMPLATES ROUTES
  // ============================================

  // Get all prompt templates available to user (own + system + public)
  app.get("/api/prompt-templates", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const category = req.query.category as string | undefined;

      // Get user's own templates
      const userTemplates = await storage.getUserPromptTemplates(req.userId!);

      // Get system templates
      const systemTemplates = await storage.getSystemPromptTemplates();

      // Get public templates (from other users)
      const publicTemplates = await storage.getPublicPromptTemplates();

      // Combine and deduplicate (user's own templates take priority, avoid system template duplicates)
      const userTemplateIds = new Set(userTemplates.map(t => t.id));
      const systemTemplateIds = new Set(systemTemplates.map(t => t.id));
      const filteredPublic = publicTemplates.filter(t =>
        !userTemplateIds.has(t.id) &&
        !systemTemplateIds.has(t.id) &&
        t.userId !== req.userId
      );

      let allTemplates = [...userTemplates, ...systemTemplates, ...filteredPublic];

      // Filter by category if specified
      if (category && category !== 'all') {
        allTemplates = allTemplates.filter(t => t.category === category);
      }

      res.json(allTemplates);
    } catch (error: any) {
      logger.error("Get prompt templates error:", error);
      res.status(500).json({ error: "Failed to get prompt templates" });
    }
  });

  // Get single prompt template
  app.get("/api/prompt-templates/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const template = await storage.getPromptTemplate(req.params.id);
      if (!template) {
        return res.status(404).json({ error: "Prompt template not found" });
      }

      // Allow access if: own template, system template, or public template
      const isOwn = template.userId === req.userId;
      const isSystem = template.isSystemTemplate;
      const isPublic = template.isPublic;

      if (!isOwn && !isSystem && !isPublic) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(template);
    } catch (error: any) {
      logger.error("Get prompt template error:", error);
      res.status(500).json({ error: "Failed to get prompt template" });
    }
  });

  // Create prompt template
  app.post("/api/prompt-templates", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      // Validate with Zod schema
      const validationResult = insertPromptTemplateSchema.safeParse({
        ...req.body,
        userId: req.userId,
        isSystemTemplate: false,
      });

      if (!validationResult.success) {
        const errors = validationResult.error.issues.map(e => e.message).join(', ');
        return res.status(400).json({ error: `Validation failed: ${errors}` });
      }

      const {
        name,
        description,
        category,
        systemPrompt,
        firstMessage,
        variables,
        suggestedVoiceTone,
        suggestedPersonality,
        isPublic
      } = validationResult.data;

      // Extract variables from template using {{variable}} pattern
      const extractedVars = (systemPrompt.match(/\{\{(\w+)\}\}/g) || [])
        .map((v: string) => v.replace(/\{\{|\}\}/g, ''));
      const firstMsgVars = (firstMessage?.match(/\{\{(\w+)\}\}/g) || [])
        .map((v: string) => v.replace(/\{\{|\}\}/g, ''));

      const allVariables = Array.from(new Set([...extractedVars, ...firstMsgVars, ...(variables || [])]));

      const template = await storage.createPromptTemplate({
        userId: req.userId!,
        name,
        description: description || null,
        category: category || 'general',
        systemPrompt,
        firstMessage: firstMessage || null,
        variables: allVariables.length > 0 ? allVariables : null,
        suggestedVoiceTone: suggestedVoiceTone || null,
        suggestedPersonality: suggestedPersonality || null,
        isSystemTemplate: false,
        isPublic: isPublic || false,
      } as PromptTemplateInsertRow);

      res.json(template);
    } catch (error: any) {
      logger.error("Create prompt template error:", error);
      res.status(500).json({ error: "Failed to create prompt template" });
    }
  });

  // Update prompt template
  app.patch("/api/prompt-templates/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const template = await storage.getPromptTemplate(req.params.id);
      if (!template) {
        return res.status(404).json({ error: "Prompt template not found" });
      }

      // Only owner can update (not system templates)
      if (template.userId !== req.userId || template.isSystemTemplate) {
        return res.status(403).json({ error: "Cannot modify this template" });
      }

      const {
        name,
        description,
        category,
        systemPrompt,
        firstMessage,
        variables,
        suggestedVoiceTone,
        suggestedPersonality,
        isPublic
      } = req.body;

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (category !== undefined) updates.category = category;
      if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
      if (firstMessage !== undefined) updates.firstMessage = firstMessage;
      if (suggestedVoiceTone !== undefined) updates.suggestedVoiceTone = suggestedVoiceTone;
      if (suggestedPersonality !== undefined) updates.suggestedPersonality = suggestedPersonality;
      if (isPublic !== undefined) updates.isPublic = isPublic;

      // Re-extract variables whenever systemPrompt or firstMessage changes
      if (systemPrompt !== undefined || firstMessage !== undefined) {
        const finalSystemPrompt = systemPrompt ?? template.systemPrompt;
        const finalFirstMessage = firstMessage ?? template.firstMessage;

        const extractedVars = (finalSystemPrompt.match(/\{\{(\w+)\}\}/g) || [])
          .map((v: string) => v.replace(/\{\{|\}\}/g, ''));
        const firstMsgVars = (finalFirstMessage?.match(/\{\{(\w+)\}\}/g) || [])
          .map((v: string) => v.replace(/\{\{|\}\}/g, ''));
        updates.variables = Array.from(new Set([...extractedVars, ...firstMsgVars]));
      }

      await storage.updatePromptTemplate(req.params.id, updates);

      const updated = await storage.getPromptTemplate(req.params.id);
      res.json(updated);
    } catch (error: any) {
      logger.error("Update prompt template error:", error);
      res.status(500).json({ error: "Failed to update prompt template" });
    }
  });

  // Delete prompt template
  app.delete("/api/prompt-templates/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const template = await storage.getPromptTemplate(req.params.id);
      if (!template) {
        return res.status(404).json({ error: "Prompt template not found" });
      }

      // Only owner can delete (not system templates)
      if (template.userId !== req.userId || template.isSystemTemplate) {
        return res.status(403).json({ error: "Cannot delete this template" });
      }

      await storage.deletePromptTemplate(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Delete prompt template error:", error);
      res.status(500).json({ error: "Failed to delete prompt template" });
    }
  });

  // Use template (increments usage count and returns interpolated content)
  app.post("/api/prompt-templates/:id/use", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const template = await storage.getPromptTemplate(req.params.id);
      if (!template) {
        return res.status(404).json({ error: "Prompt template not found" });
      }

      // Allow access if: own template, system template, or public template
      const isOwn = template.userId === req.userId;
      const isSystem = template.isSystemTemplate;
      const isPublic = template.isPublic;

      if (!isOwn && !isSystem && !isPublic) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { variableValues } = req.body;

      // Interpolate variables
      let systemPrompt = template.systemPrompt;
      let firstMessage = template.firstMessage;

      if (variableValues && typeof variableValues === 'object') {
        for (const [key, value] of Object.entries(variableValues)) {
          const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
          systemPrompt = systemPrompt.replace(regex, String(value));
          if (firstMessage) {
            firstMessage = firstMessage.replace(regex, String(value));
          }
        }
      }

      // Increment usage count
      await storage.incrementPromptTemplateUsage(req.params.id);

      res.json({
        systemPrompt,
        firstMessage,
        suggestedVoiceTone: template.suggestedVoiceTone,
        suggestedPersonality: template.suggestedPersonality,
        usedVariables: variableValues || {},
        missingVariables: (template.variables || []).filter(v =>
          !variableValues || !(v in variableValues)
        )
      });
    } catch (error: any) {
      logger.error("Use prompt template error:", error);
      res.status(500).json({ error: "Failed to use prompt template" });
    }
  });

  // Admin: Create/manage system templates
  app.post("/api/admin/prompt-templates/system", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const {
        name,
        description,
        category,
        systemPrompt,
        firstMessage,
        variables,
        suggestedVoiceTone,
        suggestedPersonality
      } = req.body;

      if (!name || !systemPrompt) {
        return res.status(400).json({ error: "Name and system prompt are required" });
      }

      const template = await storage.createPromptTemplate({
        userId: null, // System templates have no owner
        name,
        description: description || null,
        category: category || 'general',
        systemPrompt,
        firstMessage: firstMessage || null,
        variables: variables || null,
        suggestedVoiceTone: suggestedVoiceTone || null,
        suggestedPersonality: suggestedPersonality || null,
        isSystemTemplate: true,
        isPublic: true, // System templates are always public
      } as PromptTemplateInsertRow);

      res.json(template);
    } catch (error: any) {
      logger.error("Create system prompt template error:", error);
      res.status(500).json({ error: "Failed to create system prompt template" });
    }
  });
}
