import type { Express, Response } from "express";
import { storage } from "../../storage";
import { contacts } from "@shared/schema";
import { authenticateToken, type AuthRequest } from "../../middleware/auth";
import { logger } from "../../utils/logger";

export function registerContactsToolsRoutes(app: Express): void {
  // Contacts routes
  app.get("/api/contacts", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const allContacts = await storage.getUserContacts(req.userId!);

      // Check if pagination is requested
      const requestsPagination = req.query.page !== undefined || req.query.pageSize !== undefined;

      if (requestsPagination) {
        const page = parseInt(req.query.page as string, 10) || 1;
        const pageSize = parseInt(req.query.pageSize as string, 10) || 25;
        const offset = (page - 1) * pageSize;

        const totalItems = allContacts.length;
        const totalPages = Math.ceil(totalItems / pageSize);

        const paginatedContacts = allContacts.slice(offset, offset + pageSize);

        res.json({
          data: paginatedContacts,
          pagination: {
            page,
            pageSize,
            totalItems,
            totalPages
          }
        });
      } else {
        // Return plain array for backward compatibility
        res.json(allContacts);
      }
    } catch (error: any) {
      logger.error("Get all contacts error:", error);
      res.status(500).json({ error: "Failed to get contacts" });
    }
  });

  app.get("/api/contacts/deduplicated", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const contacts = await storage.getUserContactsDeduplicated(req.userId!);
      res.json(contacts);
    } catch (error: any) {
      logger.error("Get deduplicated contacts error:", error);
      res.status(500).json({ error: "Failed to get deduplicated contacts" });
    }
  });

  app.delete("/api/contacts/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const contact = await storage.getContact(req.params.id);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }

      // Verify the contact's campaign belongs to the user
      const campaign = await storage.getCampaign(contact.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Not authorized to delete this contact" });
      }

      await storage.deleteContact(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Delete contact error:", error);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  // Tools routes
  app.get("/api/tools", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const tools = await storage.getUserTools(req.userId!);
      res.json(tools);
    } catch (error: any) {
      logger.error("Get tools error:", error);
      res.status(500).json({ error: "Failed to get tools" });
    }
  });
}
