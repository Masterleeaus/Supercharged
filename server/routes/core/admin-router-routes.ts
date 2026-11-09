import type { Express, Response } from "express";
import { storage } from "../../storage";
import { authenticateToken, type AuthRequest } from "../../middleware/auth";
import { adminRouter } from "../../routes/admin-routes";
import adminTeamAccessRoutes from "../../routes/admin-team-access.routes";
import llmModelsRouter from "../../routes/llm-models-routes";
import platformLanguagesRouter from "../../routes/platform-languages-routes";
import transactionsRouter from "../../routes/transactions-routes";
import refundRouter from "../../routes/refund-routes";
import emailSettingsRouter from "../../routes/email-settings-routes";
import { generateRefundNoteForRefund, refundNoteService } from "../../services/refund-note-service";
import { safeErrorMessage } from "../../utils/safe-error";
import { logger } from "../../utils/logger";

export function registerAdminRouterRoutes(app: Express): void {
  // Admin routes accessible by admin team members (read-only analytics)
  // Must be before main admin router to take precedence
  app.use("/api/admin", adminTeamAccessRoutes);

  // Admin routes (super admin only)
  app.use("/api/admin", adminRouter);

  // LLM Models admin routes
  app.use("/api/admin/llm-models", llmModelsRouter);

  // Platform Languages admin routes (UI translations management)
  app.use("/api/admin/platform-languages", platformLanguagesRouter);

  // Payment Transactions admin routes
  app.use("/api/admin/transactions", transactionsRouter);

  // User-accessible transaction routes (non-admin)
  app.use("/api/transactions", transactionsRouter);

  // Admin Refunds routes
  app.use("/api/admin/refunds", refundRouter);

  // User-accessible refund note download (separate from admin routes)
  app.get("/api/refunds/:id/download", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const userId = req.userId!;

      const refund = await storage.getRefund(id);
      if (!refund) {
        return res.status(404).json({ message: "Refund not found" });
      }

      // Users can only download their own refund notes
      if (refund.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      if (!refund.pdfUrl) {
        try {
          const updatedRefund = await generateRefundNoteForRefund(id);
          if (!updatedRefund.pdfUrl) {
            return res.status(404).json({ message: "Refund note PDF not available" });
          }
        } catch (error) {
          return res.status(404).json({ message: "Refund note PDF not available" });
        }
      }

      const pdfBuffer = await refundNoteService.getRefundNotePDF(id);
      if (!pdfBuffer) {
        return res.status(404).json({ message: "Refund note PDF file not found" });
      }

      const latestRefund = await storage.getRefund(id);
      const fileName = latestRefund?.refundNoteNumber
        ? `${latestRefund.refundNoteNumber.replace(/\//g, '-')}.pdf`
        : `refund-note-${id}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error: unknown) {
      logger.error("Error downloading refund note:", error);
      res.status(500).json({ message: "Failed to download refund note", error: safeErrorMessage(error, "Failed to download refund note") });
    }
  });

  // Admin Email Settings routes
  app.use("/api/admin/email-settings", emailSettingsRouter);
}
