/** Form CRUD and submission routes. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { forms, formFields, formSubmissions } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { companyForRead } from "./shared";
import { logger } from '../../utils/logger.ts';

export function registerFormRoutes(router: Router): void {
  router.get("/forms", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;

      const companyId = companyForRead(req, res);
      if (!companyId) return;

      const userForms = await db
        .select()
        .from(forms)
        .where(and(eq(forms.userId, userId), eq(forms.companyId, companyId)))
        .orderBy(desc(forms.createdAt));

      // Include fields and submission count for each form
      const formsWithFieldsAndCount = await Promise.all(
        userForms.map(async (form) => {
          const fields = await db
            .select()
            .from(formFields)
            .where(and(eq(formFields.formId, form.id), eq(formFields.companyId, companyId)))
            .orderBy(formFields.order);

          // Get submission count
          const [submissionResult] = await db
            .select({ count: sql<number>`count(*)` })
            .from(formSubmissions)
            .where(and(eq(formSubmissions.formId, form.id), eq(formSubmissions.companyId, companyId)));

          return {
            ...form,
            fields,
            submissionCount: Number(submissionResult?.count || 0)
          };
        })
      );

      res.json(formsWithFieldsAndCount);
    } catch (error: any) {
      logger.error("Error fetching forms:", error);
      res.status(500).json({ error: "Failed to fetch forms" });
    }
  });

  router.get("/forms/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      const [form] = await db
        .select()
        .from(forms)
        .where(and(eq(forms.id, id), eq(forms.userId, userId), eq(forms.companyId, companyId)));

      if (!form) {
        return res.status(404).json({ error: "Form not found" });
      }

      const fields = await db
        .select()
        .from(formFields)
        .where(and(eq(formFields.formId, id), eq(formFields.companyId, companyId)))
        .orderBy(formFields.order);

      res.json({ ...form, fields });
    } catch (error: any) {
      logger.error("Error fetching form:", error);
      res.status(500).json({ error: "Failed to fetch form" });
    }
  });

  router.post("/forms", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { name, description, fields } = req.body;

      const formId = nanoid();
      const [newForm] = await db
        .insert(forms)
        .values({
          id: formId,
          userId,
          companyId,
          name,
          description,
        })
        .returning();

      if (fields && fields.length > 0) {
        const fieldValues = fields.map((field: any, index: number) => ({
          id: nanoid(),
          formId,
          companyId,
          question: field.question,
          fieldType: field.fieldType,
          options: field.options,
          isRequired: field.isRequired ?? true,
          order: index,
        }));

        await db.insert(formFields).values(fieldValues);
      }

      const createdFields = await db
        .select()
        .from(formFields)
        .where(and(eq(formFields.formId, formId), eq(formFields.companyId, companyId)))
        .orderBy(formFields.order);

      res.json({ ...newForm, fields: createdFields });
    } catch (error: any) {
      logger.error("Error creating form:", error);
      res.status(500).json({ error: "Failed to create form" });
    }
  });

  router.patch("/forms/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;
      const { name, description, fields } = req.body;

      const [updatedForm] = await db
        .update(forms)
        .set({
          name,
          description,
          updatedAt: new Date(),
        })
        .where(and(eq(forms.id, id), eq(forms.userId, userId), eq(forms.companyId, companyId)))
        .returning();

      if (!updatedForm) {
        return res.status(404).json({ error: "Form not found" });
      }

      if (fields) {
        await db.delete(formFields).where(eq(formFields.formId, id));

        if (fields.length > 0) {
          const fieldValues = fields.map((field: any, index: number) => ({
            id: nanoid(),
            formId: id,
            companyId,
            question: field.question,
            fieldType: field.fieldType,
            options: field.options,
            isRequired: field.isRequired ?? true,
            order: index,
          }));

          await db.insert(formFields).values(fieldValues);
        }
      }

      const updatedFields = await db
        .select()
        .from(formFields)
        .where(and(eq(formFields.formId, id), eq(formFields.companyId, companyId)))
        .orderBy(formFields.order);

      res.json({ ...updatedForm, fields: updatedFields });
    } catch (error: any) {
      logger.error("Error updating form:", error);
      res.status(500).json({ error: "Failed to update form" });
    }
  });

  router.delete("/forms/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const { id } = req.params;

      await db
        .delete(forms)
        .where(and(eq(forms.id, id), eq(forms.userId, userId)));

      res.json({ success: true });
    } catch (error: any) {
      logger.error("Error deleting form:", error);
      res.status(500).json({ error: "Failed to delete form" });
    }
  });

  router.get("/forms/:id/submissions", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      const [form] = await db
        .select()
        .from(forms)
        .where(and(eq(forms.id, id), eq(forms.userId, userId), eq(forms.companyId, companyId)));

      if (!form) {
        return res.status(404).json({ error: "Form not found" });
      }

      const submissions = await db
        .select()
        .from(formSubmissions)
        .where(and(eq(formSubmissions.formId, id), eq(formSubmissions.companyId, companyId)))
        .orderBy(desc(formSubmissions.submittedAt));

      res.json(submissions);
    } catch (error: any) {
      logger.error("Error fetching form submissions:", error);
      res.status(500).json({ error: "Failed to fetch form submissions" });
    }
  });
}
