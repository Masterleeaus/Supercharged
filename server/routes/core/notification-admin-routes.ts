import type { Express, Response } from "express";
import { storage } from "../../storage";
import { users } from "@shared/schema";
import { authenticateToken, type AuthRequest } from "../../middleware/auth";
import { logger } from "../../utils/logger";

export function registerNotificationAdminRoutes(app: Express): void {
  // Notifications
  app.get("/api/notifications", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const notifications = await storage.getUserNotifications(req.userId!, limit);
      res.json(notifications);
    } catch (error: any) {
      logger.error("Get notifications error:", error);
      res.status(500).json({ error: "Failed to get notifications" });
    }
  });

  app.get("/api/notifications/unread-count", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const count = await storage.getUnreadNotificationCount(req.userId!);
      res.json({ count });
    } catch (error: any) {
      logger.error("Get unread count error:", error);
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  app.patch("/api/notifications/:id/read", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const notification = await storage.getNotification(req.params.id);
      if (!notification || notification.userId !== req.userId) {
        return res.status(404).json({ error: "Notification not found" });
      }

      await storage.markNotificationAsRead(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Mark notification as read error:", error);
      res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  app.post("/api/notifications/read-all", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      await storage.markAllNotificationsAsRead(req.userId!);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Mark all notifications as read error:", error);
      res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
  });

  app.delete("/api/notifications/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const notification = await storage.getNotification(req.params.id);
      if (!notification || notification.userId !== req.userId) {
        return res.status(404).json({ error: "Notification not found" });
      }

      await storage.deleteNotification(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Delete notification error:", error);
      res.status(500).json({ error: "Failed to delete notification" });
    }
  });

  app.get("/api/notifications/banner", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const notifications = await storage.getBannerNotifications(req.userId!);
      res.json(notifications);
    } catch (error: any) {
      logger.error("Get banner notifications error:", error);
      res.status(500).json({ error: "Failed to get banner notifications" });
    }
  });

  app.patch("/api/notifications/:id/dismiss", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const notification = await storage.getNotification(req.params.id);
      if (!notification || notification.userId !== req.userId) {
        return res.status(404).json({ error: "Notification not found" });
      }

      await storage.dismissNotification(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logger.error("Dismiss notification error:", error);
      res.status(500).json({ error: "Failed to dismiss notification" });
    }
  });

  app.post("/api/admin/notifications/broadcast", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.userId!);
      if (user?.role !== 'admin') {
        return res.status(403).json({ error: "Only admins can send broadcast notifications" });
      }

      const {
        title,
        message,
        link,
        type = 'system',
        icon,
        displayType = 'bell',
        priority = 0,
        dismissible = true,
        expiresAt
      } = req.body;

      if (!title || !message) {
        return res.status(400).json({ error: "Title and message are required" });
      }

      if (displayType && !['bell', 'banner', 'both'].includes(displayType)) {
        return res.status(400).json({ error: "displayType must be 'bell', 'banner', or 'both'" });
      }

      if (priority !== undefined && (typeof priority !== 'number' || priority < 0)) {
        return res.status(400).json({ error: "priority must be a non-negative number" });
      }

      if (dismissible !== undefined && typeof dismissible !== 'boolean') {
        return res.status(400).json({ error: "dismissible must be a boolean" });
      }

      let parsedExpiresAt: Date | null = null;
      if (expiresAt) {
        parsedExpiresAt = new Date(expiresAt);
        if (isNaN(parsedExpiresAt.getTime())) {
          return res.status(400).json({ error: "expiresAt must be a valid date" });
        }
      }

      const users = await storage.getAllUsers();
      const notifications = await Promise.all(
        users.map(u => storage.createNotification({
          userId: u.id,
          type,
          title,
          message,
          link: link || null,
          icon: icon || null,
          displayType,
          priority,
          dismissible,
          expiresAt: parsedExpiresAt,
        }))
      );

      res.json({
        success: true,
        recipientCount: notifications.length,
        message: `Broadcast sent to ${notifications.length} users`
      });
    } catch (error: any) {
      logger.error("Broadcast notification error:", error);
      res.status(500).json({ error: "Failed to send broadcast notification" });
    }
  });
}
