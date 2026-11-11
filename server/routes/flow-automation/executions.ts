/** Flow execution list route with auto-sync of stale runs. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { flows, webhooks, flowExecutions, calls, contacts, plivoCalls, sipCalls, twilioOpenaiCalls } from "@shared/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { logger } from "../../utils/logger";
import { companyForRead } from "./shared";

export function registerExecutionRoutes(router: Router): void {
  router.get("/executions", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { flowId, callId, status } = req.query;

      const userFlows = await db
        .select({ id: flows.id, nodes: flows.nodes })
        .from(flows)
        .where(and(eq(flows.userId, userId), eq(flows.companyId, companyId)));

      const userFlowIds = userFlows.map(f => f.id);

      if (userFlowIds.length === 0) {
        return res.json([]);
      }

      const flowNodesMap: Record<string, import('@shared/schema').FlowNode[]> = {};
      for (const flow of userFlows) {
        flowNodesMap[flow.id] = (flow.nodes || []) as import('@shared/schema').FlowNode[];
      }

      const conditions: any[] = [inArray(flowExecutions.flowId, userFlowIds), eq(flowExecutions.companyId, companyId)];

      if (flowId) conditions.push(eq(flowExecutions.flowId, flowId as string));
      if (callId) conditions.push(eq(flowExecutions.callId, callId as string));
      if (status) conditions.push(eq(flowExecutions.status, status as string));

      const executionsWithDetails = await db
        .select({
          id: flowExecutions.id,
          callId: flowExecutions.callId,
          flowId: flowExecutions.flowId,
          flowName: flows.name,
          flowNodes: flows.nodes,
          currentNodeId: flowExecutions.currentNodeId,
          status: flowExecutions.status,
          variables: flowExecutions.variables,
          pathTaken: flowExecutions.pathTaken,
          metadata: flowExecutions.metadata,
          error: flowExecutions.error,
          startedAt: flowExecutions.startedAt,
          completedAt: flowExecutions.completedAt,
          phoneNumber: calls.phoneNumber,
          callStatus: calls.status,
          contactId: calls.contactId,
          callDuration: calls.duration,
          callEndedAt: calls.endedAt,
          callTranscript: calls.transcript,
          callAiSummary: calls.aiSummary,
        })
        .from(flowExecutions)
        .leftJoin(flows, eq(flowExecutions.flowId, flows.id))
        .leftJoin(calls, and(eq(flowExecutions.callId, calls.id), eq(calls.companyId, companyId)))
        .where(and(...conditions))
        .orderBy(desc(flowExecutions.startedAt))
        .limit(100);

      // Fetch and map Custom Voice Engine session details if not found in the main calls table
      const unmatchedCallIds = executionsWithDetails
        .filter(e => e.callStatus === null && e.callId)
        .map(e => e.callId);

      if (unmatchedCallIds.length > 0) {
        try {
          const veSessionsResult = await db.execute(sql`
          SELECT s.*, rec.storage_url as recording_url
          FROM ve_sessions s
          LEFT JOIN ve_call_recordings rec ON s.id = rec.session_id AND rec.status = 'available'
          WHERE s.id IN (${sql.join(unmatchedCallIds, sql`, `)})
        `);

          const veSessionsMap = new Map(veSessionsResult.rows.map((r: any) => [r.id, r]));

          for (const exec of executionsWithDetails) {
            if (exec.callStatus === null && exec.callId) {
              const veSess = veSessionsMap.get(exec.callId);
              if (veSess) {
                exec.phoneNumber = veSess.direction === 'inbound' ? veSess.from_number : veSess.to_number;
                exec.callStatus = veSess.status;
                exec.callDuration = veSess.duration_seconds;
                exec.callEndedAt = veSess.ended_at ? new Date(veSess.ended_at) : null;
                exec.callTranscript = typeof veSess.transcript === 'string' ? veSess.transcript : JSON.stringify(veSess.transcript || []);
                exec.callAiSummary = veSess.ai_summary;
              }
            }
          }
        } catch (err) {
          logger.error("Error fetching ve_sessions details for flow executions:", err);
        }
      }

      // Auto-sync: Fix any executions that show "running" but whose call is completed
      // First sync from main calls table
      const executionsToSync = executionsWithDetails.filter(
        e => e.status === 'running' && e.callStatus === 'completed' && e.callEndedAt
      );

      if (executionsToSync.length > 0) {
        logger.info(`[Executions API] Syncing ${executionsToSync.length} stale executions from calls table`);
        for (const exec of executionsToSync) {
          await db
            .update(flowExecutions)
            .set({
              status: 'completed',
              completedAt: exec.callEndedAt,
            })
            .where(eq(flowExecutions.id, exec.id));

          // Update in-memory for this response - using Object.assign for type-safe mutation
          Object.assign(exec, { status: 'completed', completedAt: exec.callEndedAt });
        }
      }

      // Second pass: Sync from Plivo calls table for executions still showing "running"
      const stillRunningExecs = executionsWithDetails.filter(
        e => e.status === 'running' && !e.callStatus
      );

      if (stillRunningExecs.length > 0) {
        const stillRunningCallIds = stillRunningExecs.map(e => e.callId);

        // Check plivoCalls table
        const plivoCallStatuses = await db
          .select({ id: plivoCalls.id, status: plivoCalls.status, endedAt: plivoCalls.endedAt })
          .from(plivoCalls)
          .where(and(inArray(plivoCalls.id, stillRunningCallIds), eq(plivoCalls.companyId, companyId)));

        const plivoCallMap = new Map(plivoCallStatuses.map(c => [c.id, c]));

        // Check twilioOpenaiCalls table
        const twilioOpenaiStatuses = await db
          .select({ id: twilioOpenaiCalls.id, status: twilioOpenaiCalls.status, endedAt: twilioOpenaiCalls.endedAt })
          .from(twilioOpenaiCalls)
          .where(and(inArray(twilioOpenaiCalls.id, stillRunningCallIds), eq(twilioOpenaiCalls.companyId, companyId)));

        const twilioOpenaiMap = new Map(twilioOpenaiStatuses.map(c => [c.id, c]));

        // Check sipCalls table
        const sipCallStatuses = await db
          .select({ id: sipCalls.id, status: sipCalls.status, endedAt: sipCalls.endedAt })
          .from(sipCalls)
          .where(and(inArray(sipCalls.id, stillRunningCallIds), eq(sipCalls.companyId, companyId)));

        const sipCallMap = new Map(sipCallStatuses.map(c => [c.id, c]));

        for (const exec of stillRunningExecs) {
          const plivoCall = plivoCallMap.get(exec.callId);
          const twilioCall = twilioOpenaiMap.get(exec.callId);
          const sipCall = sipCallMap.get(exec.callId);

          const callInfo = plivoCall || twilioCall || sipCall;

          if (callInfo && callInfo.status && ['completed', 'failed', 'busy', 'no-answer', 'canceled', 'cancelled'].includes(callInfo.status)) {
            const execStatus = callInfo.status === 'completed' ? 'completed' : 'failed';
            await db
              .update(flowExecutions)
              .set({
                status: execStatus,
                completedAt: callInfo.endedAt || new Date(),
                error: callInfo.status !== 'completed' ? `Call ended with status: ${callInfo.status}` : null,
              })
              .where(eq(flowExecutions.id, exec.id));

            Object.assign(exec, { status: execStatus, completedAt: callInfo.endedAt || new Date() });
            logger.info(`[Executions API] Synced execution ${exec.id} from alternate call table to ${execStatus}`);
          }
        }
      }

      // Third pass: Timeout-based cleanup for stale executions
      // If execution started >5 minutes ago and is still "running", mark as failed
      // This handles cases where status webhooks never arrived
      const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const now = new Date();

      const staleExecs = executionsWithDetails.filter(e => {
        if (e.status !== 'running') return false;
        if (!e.startedAt) return false;
        const startedAt = new Date(e.startedAt);
        const ageMs = now.getTime() - startedAt.getTime();
        return ageMs > STALE_TIMEOUT_MS;
      });

      if (staleExecs.length > 0) {
        logger.error(`[Executions API] Found ${staleExecs.length} stale executions (>5 min old), marking as failed`);
        for (const exec of staleExecs) {
          await db
            .update(flowExecutions)
            .set({
              status: 'failed',
              completedAt: new Date(),
              error: 'Call status unknown - marked as failed after timeout (status webhook may not have been received)',
            })
            .where(eq(flowExecutions.id, exec.id));

          Object.assign(exec, {
            status: 'failed',
            completedAt: new Date(),
            error: 'Call status unknown - marked as failed after timeout'
          });
          logger.error(`[Executions API] Marked stale execution ${exec.id} as failed (started ${exec.startedAt})`);
        }
      }

      // Look up contact names for executions with contactId
      const contactIds = executionsWithDetails
        .map(e => e.contactId)
        .filter((id): id is string => id !== null);

      const contactsMap: Record<string, { name: string; phone: string }> = {};
      if (contactIds.length > 0) {
        const contactRecords = await db
          .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, phone: contacts.phone })
          .from(contacts)
          .where(and(inArray(contacts.id, contactIds), eq(contacts.companyId, companyId)));

        for (const c of contactRecords) {
          const fullName = c.lastName ? `${c.firstName} ${c.lastName}` : c.firstName;
          contactsMap[c.id] = { name: fullName, phone: c.phone };
        }
      }

      const enrichedExecutions = executionsWithDetails.map(execution => {
        const nodes = (execution.flowNodes || []) as import('@shared/schema').FlowNode[];
        const pathTaken = (execution.pathTaken || []) as string[];

        // Get contact info - prioritize contacts table, fallback to call phoneNumber
        const contactInfo = execution.contactId ? contactsMap[execution.contactId] : null;

        const detailedPath = pathTaken.map((nodeId, index) => {
          const node = nodes.find(n => n.id === nodeId);
          if (!node) {
            return {
              nodeId,
              stepNumber: index + 1,
              type: 'unknown',
              label: nodeId,
              content: null
            };
          }

          const config = (node.data?.config || {}) as any;
          let content: string | null = null;
          let label = node.data?.label || node.type || 'Unknown';

          switch (node.type) {
            case 'message':
              content = config.message || null;
              label = 'Message';
              break;
            case 'question':
              content = config.question || null;
              label = `Question: ${config.variableName || 'response'}`;
              break;
            case 'condition':
              content = `Checking: ${config.conditions?.map((c: any) => c.value).join(', ') || 'conditions'}`;
              label = 'Decision';
              break;
            case 'transfer':
              content = `Transfer to: ${config.transferNumber || 'unknown'}`;
              label = 'Transfer';
              break;
            case 'webhook':
              content = `Webhook: ${config.url || 'unknown'}`;
              label = 'Webhook';
              break;
            case 'appointment':
              content = config.serviceName || 'Schedule appointment';
              label = 'Appointment';
              break;
            case 'form':
              content = 'Collecting form data';
              label = 'Form';
              break;
            case 'delay':
              content = `Wait ${config.seconds || 0} seconds`;
              label = 'Delay';
              break;
            case 'end':
              content = config.message || 'End call';
              label = 'End';
              break;
          }

          return {
            nodeId,
            stepNumber: index + 1,
            type: node.type,
            label,
            content
          };
        });

        const { flowNodes, contactId, phoneNumber, callDuration, callEndedAt, callTranscript, callAiSummary, ...rest } = execution;
        const metadataObj = (execution.metadata || {}) as { contactPhone?: string; telephonyProvider?: string; testCall?: boolean };

        return {
          ...rest,
          contactPhone: contactInfo?.phone || phoneNumber || metadataObj.contactPhone || null,
          contactName: contactInfo?.name || null,
          duration: callDuration || null,
          transcriptPreview: callTranscript ? (callTranscript.length > 200 ? callTranscript.substring(0, 200) + '...' : callTranscript) : null,
          aiSummary: callAiSummary || null,
          detailedPath,
          isTestCall: metadataObj.testCall || false,
          telephonyProvider: metadataObj.telephonyProvider || null,
        };
      });

      res.json(enrichedExecutions);
    } catch (error: any) {
      logger.error("Error fetching flow executions:", error);
      res.status(500).json({ error: "Failed to fetch flow executions" });
    }
  });
}
