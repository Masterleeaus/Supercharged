import type { Express, Response } from "express";
import { storage } from "../../storage";
import { db } from "../../db";
import { calls, campaigns, incomingConnections, users } from "@shared/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { authenticateToken, requireRole, type AuthRequest } from "../../middleware/auth";
import { campaignExecutor } from "../../services/campaign-executor";
import { BatchCallingService } from "../../services/batch-calling";

export function registerAdminCampaignRoutes(app: Express): void {
  // Admin Campaign View Routes (allows admins to view any user's campaign)
  app.get("/api/admin/campaigns/:id", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      // Include owner info for admin context
      const [owner] = await db.select({
        id: users.id,
        name: users.name,
        email: users.email
      }).from(users).where(eq(users.id, campaign.userId)).limit(1);

      res.json({ ...campaign, owner: owner || null });
    } catch (error: any) {
      console.error("Admin get campaign error:", error);
      res.status(500).json({ error: "Failed to get campaign" });
    }
  });

  app.get("/api/admin/campaigns/:id/contacts", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const contactList = await storage.getCampaignContacts(campaign.id);

      res.json(contactList);
    } catch (error: any) {
      console.error("Admin get campaign contacts error:", error);
      res.status(500).json({ error: "Failed to get campaign contacts" });
    }
  });

  app.get("/api/admin/campaigns/:id/calls", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const callList = await storage.getCampaignCalls(campaign.id);
      res.json(callList);
    } catch (error: any) {
      console.error("Admin get campaign calls error:", error);
      res.status(500).json({ error: "Failed to get campaign calls" });
    }
  });

  app.get("/api/admin/campaigns/:id/batch", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const batchJob = await campaignExecutor.getBatchJobStatus(campaign.id);
      if (!batchJob) {
        return res.json({ batchJob: null, stats: null });
      }

      const stats = BatchCallingService.getBatchStats(batchJob);
      res.json({ batchJob, stats });
    } catch (error: any) {
      console.error("Admin get campaign batch error:", error);
      res.json({ batchJob: null, stats: null });
    }
  });

  // Admin endpoint to migrate userId for orphaned calls
  // This populates userId for existing calls based on campaign/connection ownership
  // Uses batched processing to handle any number of orphaned calls
  app.post("/api/admin/migrate-call-user-ids", authenticateToken, requireRole("admin"), async (req: AuthRequest, res: Response) => {
    try {
      console.log(`📊 [Admin] Starting call userId migration`);

      let totalProcessed = 0;
      let migrated = 0;
      let failed = 0;
      const errors: string[] = [];
      const unresolvedCallIds: string[] = [];
      const BATCH_SIZE = 500;

      // Process in batches until no orphaned calls remain
      while (true) {
        // Find next batch of orphaned calls, ordered by id for consistent processing
        // Exclude calls already marked as orphaned in metadata to prevent infinite loop
        // Handle null metadata by treating it as not orphaned (needs processing)
        const orphanedCalls = await db
          .select({
            id: calls.id,
            campaignId: calls.campaignId,
            incomingConnectionId: calls.incomingConnectionId,
            callDirection: calls.callDirection,
          })
          .from(calls)
          .where(and(
            isNull(calls.userId),
            sql`NOT COALESCE((COALESCE(metadata, '{}')::jsonb->>'orphaned')::boolean, false)`
          ))
          .orderBy(calls.id)
          .limit(BATCH_SIZE);

        if (orphanedCalls.length === 0) {
          console.log(`   No more orphaned calls to process`);
          break;
        }

        console.log(`   Processing batch of ${orphanedCalls.length} orphaned calls`);
        totalProcessed += orphanedCalls.length;

        for (const call of orphanedCalls) {
          let resolvedUserId: string | null = null;

          try {
            // Try to resolve userId from campaign
            if (call.campaignId) {
              const [campaign] = await db
                .select({ userId: campaigns.userId })
                .from(campaigns)
                .where(eq(campaigns.id, call.campaignId))
                .limit(1);

              if (campaign?.userId) {
                resolvedUserId = campaign.userId;
              }
            }

            // Try to resolve from incoming connection
            if (!resolvedUserId && call.incomingConnectionId) {
              const [connection] = await db
                .select({ userId: incomingConnections.userId })
                .from(incomingConnections)
                .where(eq(incomingConnections.id, call.incomingConnectionId))
                .limit(1);

              if (connection?.userId) {
                resolvedUserId = connection.userId;
              }
            }

            if (resolvedUserId) {
              await db
                .update(calls)
                .set({ userId: resolvedUserId })
                .where(eq(calls.id, call.id));
              migrated++;
            } else {
              // Mark call with a special "ORPHANED" flag in metadata to prevent reprocessing
              // Set userId to empty string to mark as processed but unresolved
              // These calls have no resolvable owner and need manual review
              const currentMetadata = call.campaignId || call.incomingConnectionId
                ? { orphaned: true, reason: 'Owner reference exists but owner not found' }
                : { orphaned: true, reason: 'No campaign or connection reference' };

              await db
                .update(calls)
                .set({
                  metadata: sql`COALESCE(metadata, '{}')::jsonb || ${JSON.stringify(currentMetadata)}::jsonb`
                })
                .where(eq(calls.id, call.id));

              failed++;
              if (unresolvedCallIds.length < 500) {
                unresolvedCallIds.push(call.id);
              }
              if (errors.length < 100) {
                errors.push(`Call ${call.id}: No ownership source found (campaign: ${call.campaignId}, connection: ${call.incomingConnectionId})`);
              }
            }
          } catch (err: any) {
            failed++;
            if (errors.length < 100) {
              errors.push(`Call ${call.id}: ${err.message}`);
            }
          }
        }

        // Safety check - if we've processed many calls without finding resolvable owners
        // and the same orphaned calls keep appearing, prevent infinite loop
        if (totalProcessed > 10000 && migrated === 0) {
          console.warn(`   Breaking - processed ${totalProcessed} calls but none could be migrated`);
          break;
        }
      }

      console.log(`✅ [Admin] Migration complete: ${migrated} migrated, ${failed} unresolvable, ${totalProcessed} total processed`);

      res.json({
        success: true,
        totalProcessed,
        migrated,
        unresolvable: failed,
        unresolvedCallIds: unresolvedCallIds.slice(0, 100), // Return first 100 unresolved IDs for manual review
        errors: errors.slice(0, 50), // Return first 50 errors
        message: failed > 0
          ? `${migrated} calls migrated, ${failed} calls have no resolvable owner (missing campaign/connection reference)`
          : `Successfully migrated all ${migrated} calls`
      });
    } catch (error: any) {
      console.error("Migration error:", error);
      res.status(500).json({ error: "Failed to migrate call user IDs" });
    }
  });
}
