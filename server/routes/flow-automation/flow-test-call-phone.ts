/** Test-call caller-ID selection and active-campaign warning, moved out of placeFlowTestCall unchanged. */
import { db } from "../../db";
import { flowTestQueue, phoneNumbers, calls, agents, incomingConnections, campaigns, plivoPhoneNumbers } from "@shared/schema";
import { eq, and, or, desc, sql, inArray, isNull } from "drizzle-orm";
import { logger } from "../../utils/logger";
import { FlowTestHttpError, type FlowTestAgent, type FlowTestFlow, type FlowTestFailQueue, type FlowTestCampaignWarning } from "./flow-test-call-types";

export async function selectFlowTestFromPhone({
  userId,
  companyId,
  flow,
  agent,
  phoneNumber,
  queueEntryId,
  failQueue,
}: {
  userId: string;
  companyId: string;
  flow: FlowTestFlow;
  agent: FlowTestAgent;
  phoneNumber: string;
  queueEntryId?: string;
  failQueue: FlowTestFailQueue;
}): Promise<any> {
  // Get all phone numbers connected to incoming agents (to exclude them)
  const incomingConnectedPhoneIds = await db
    .select({ phoneNumberId: incomingConnections.phoneNumberId })
    .from(incomingConnections)
    .where(eq(incomingConnections.companyId, companyId));
  const connectedPhoneIdSet = new Set(incomingConnectedPhoneIds.map(ic => ic.phoneNumberId));

  // Helper to get connected agent names for error messages
  const getConnectedAgentNames = async (phoneIds: string[]) => {
    if (phoneIds.length === 0) return "";
    const connectedAgents = await db
      .select({ name: agents.name })
      .from(agents)
      .innerJoin(incomingConnections, eq(incomingConnections.agentId, agents.id))
      .where(and(inArray(incomingConnections.phoneNumberId, phoneIds), eq(incomingConnections.companyId, companyId), eq(agents.companyId, companyId)));
    return connectedAgents.map(a => a.name).join(", ");
  };

  let fromPhone: any;

  if (agent.telephonyProvider === 'custom-voice-engine') {
    let activeGateway: any = null;
    if (userId) {
      const userGatewayResult = await db.execute(sql`
        SELECT id, name, proxy FROM user_sip_gateways WHERE user_id = ${userId} AND is_active = true LIMIT 1
      `);
      activeGateway = (userGatewayResult.rows as any[])[0];
    }

    const gatewayName = activeGateway ? activeGateway.name.toLowerCase() : 'twilio';

    logger.info(`📞 [Flow Test] Custom Voice Engine agent detected, fetching active ${gatewayName} phone number for Caller ID`);

    const agentSipPhoneResult = await db.execute(sql`
      SELECT phone_number FROM user_sip_phone_numbers 
      WHERE user_id = ${userId} AND agent_id = ${agent.id} AND is_active = true 
      LIMIT 1
    `);
    const agentSipPhone = (agentSipPhoneResult.rows as any[])[0];

    if (agentSipPhone) {
      fromPhone = { phoneNumber: agentSipPhone.phone_number };
    } else {
      const gatewayId = activeGateway?.id || null;
      // Fallback: Check if there's any active number for the user's active gateway
      const userSipPhoneResult = await db.execute(sql`
        SELECT phone_number FROM user_sip_phone_numbers 
        WHERE user_id = ${userId} AND gateway_id = ${gatewayId} AND is_active = true 
        LIMIT 1
      `);

      const userSipPhone = (userSipPhoneResult.rows as any[])[0];

      if (userSipPhone) {
        fromPhone = { phoneNumber: userSipPhone.phone_number };
      } else if (gatewayName === 'plivo') {
        const userPlivoPhones = await db
          .select()
          .from(plivoPhoneNumbers)
          .where(and(
            and(eq(plivoPhoneNumbers.userId, userId), eq(plivoPhoneNumbers.companyId, companyId)),
            eq(plivoPhoneNumbers.status, 'active')
          ));
        if (userPlivoPhones.length > 0) {
          fromPhone = userPlivoPhones[0];
        } else {
          fromPhone = { phoneNumber: 'FreeSWITCH' };
        }
      } else {
        const userTwilioPhones = await db
          .select()
          .from(phoneNumbers)
          .where(and(
            and(eq(phoneNumbers.userId, userId), eq(phoneNumbers.companyId, companyId)),
            inArray(phoneNumbers.status, ["active", "assigned"])
          ));

        if (userTwilioPhones.length > 0) {
          fromPhone = userTwilioPhones[0];
        } else {
          const systemPoolPhones = await db
            .select()
            .from(phoneNumbers)
            .where(and(
              and(eq(phoneNumbers.isSystemPool, true), or(isNull(phoneNumbers.companyId), eq(phoneNumbers.companyId, companyId))),
              eq(phoneNumbers.status, "available"),
              isNull(phoneNumbers.userId)
            ))
            .orderBy(desc(phoneNumbers.purchasedAt));
          if (systemPoolPhones.length > 0) {
            fromPhone = systemPoolPhones[0];
          } else {
            fromPhone = { phoneNumber: 'FreeSWITCH' };
          }
        }
      }
    }
    logger.info(`📞 [Flow Test] Using ${gatewayName} phone for Caller ID: [redacted]`);
  }

  // ========================================
  // PLIVO AGENT - Use Plivo phone numbers only
  // ========================================
  else if (agent.telephonyProvider === 'plivo') {
    logger.info(`📞 [Flow Test] Plivo agent detected, looking for Plivo phone numbers`);

    const userPlivoPhones = await db
      .select()
      .from(plivoPhoneNumbers)
      .where(and(
        and(eq(plivoPhoneNumbers.userId, userId), eq(plivoPhoneNumbers.companyId, companyId)),
        eq(plivoPhoneNumbers.status, 'active')
      ));

    if (userPlivoPhones.length === 0) {
      throw new FlowTestHttpError(400, {
        error: "No Plivo phone number available",
        message: "This agent uses Plivo + OpenAI Realtime but you don't have any Plivo phone numbers. Please purchase a Plivo phone number in the Phone Numbers section.",
        needsPhonePurchase: true,
        provider: 'plivo',
      });
    }

    // Use first available Plivo phone (Plivo phones don't have incoming connections like Twilio)
    fromPhone = userPlivoPhones[0];
    logger.info(`📞 [Flow Test] Using Plivo phone: [redacted]`);
  }

  // ========================================
  // TWILIO+OPENAI AGENT - Use Twilio phone numbers only
  // ========================================
  else if (agent.telephonyProvider === 'twilio_openai') {
    logger.info(`📞 [Flow Test] Twilio+OpenAI agent detected, looking for Twilio phone numbers`);

    const userTwilioPhones = await db
      .select()
      .from(phoneNumbers)
      .where(and(
        and(eq(phoneNumbers.userId, userId), eq(phoneNumbers.companyId, companyId)),
        inArray(phoneNumbers.status, ["active", "assigned"])
      ));

    if (userTwilioPhones.length === 0) {
      // No user phones, check system pool
      const systemPoolPhones = await db
        .select()
        .from(phoneNumbers)
        .where(and(
          and(eq(phoneNumbers.isSystemPool, true), or(isNull(phoneNumbers.companyId), eq(phoneNumbers.companyId, companyId))),
          eq(phoneNumbers.status, "available"),
          isNull(phoneNumbers.userId)
        ))
        .orderBy(desc(phoneNumbers.purchasedAt));

      const availableSystemPhones = systemPoolPhones.filter(p => !connectedPhoneIdSet.has(p.id));

      if (availableSystemPhones.length > 0) {
        // Check which pool numbers are currently busy (have active calls)
        const activeCallRows = await db
          .select({ fromNumber: calls.fromNumber })
          .from(calls)
          .where(and(inArray(calls.status, ['pending', 'initiated', 'ringing', 'in-progress']), eq(calls.companyId, companyId)));
        const busyNumbers = new Set(activeCallRows.map(r => r.fromNumber).filter(Boolean));
        const freeSystemPhones = availableSystemPhones.filter(p => !busyNumbers.has(p.phoneNumber));

        if (freeSystemPhones.length === 0) {
          if (queueEntryId) {
            await failQueue("All phone numbers became busy. Please try again.");
            throw new FlowTestHttpError(503, {
              error: "No phone numbers available",
              message: "All phone numbers became busy. Please try again in a moment.",
            });
          }
          const [queueEntry] = await db.insert(flowTestQueue).values({
            userId,
            companyId,
            flowId: flow.id,
            toPhone: phoneNumber,
            status: 'waiting',
          }).returning();
          const [{ count }] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(flowTestQueue)
            .where(and(eq(flowTestQueue.status, 'waiting'), eq(flowTestQueue.companyId, companyId)));
          logger.info(`⏳ [Flow Test] All pool numbers busy, queued as entry ${queueEntry.id} (position ${count})`);
          throw new FlowTestHttpError(202, {
            queued: true,
            queueEntryId: queueEntry.id,
            position: count ?? 1,
            message: "All phone numbers are currently busy. You have been added to the queue.",
          });
        }

        fromPhone = freeSystemPhones[0];
        logger.info(`📞 [Flow Test] Using system pool Twilio phone: [redacted]`);
      } else {
        throw new FlowTestHttpError(400, {
          error: "No Twilio phone number available",
          message: "This agent uses Twilio + OpenAI Realtime but you don't have any Twilio phone numbers available. Please purchase a Twilio phone number in the Phone Numbers section.",
          needsPhonePurchase: true,
          provider: 'twilio',
        });
      }
    } else {
      const availableUserPhones = userTwilioPhones.filter(p => !connectedPhoneIdSet.has(p.id));
      if (availableUserPhones.length > 0) {
        fromPhone = availableUserPhones[0];
        logger.info(`📞 [Flow Test] Using Twilio phone: [redacted]`);
      } else {
        const agentNames = await getConnectedAgentNames(userTwilioPhones.map(p => p.id));
        throw new FlowTestHttpError(409, {
          error: "Phone number conflict",
          message: `All your Twilio phone numbers are connected to incoming agents (${agentNames}). A phone number can only be used for either incoming calls OR outbound campaigns/tests, not both.`,
          suggestion: "Please purchase a new Twilio phone number for outbound calls, or disconnect one of your numbers from the incoming agent first.",
          conflictType: "incoming_connection",
          connectedAgentName: agentNames,
        });
      }
    }
  }

  // ELEVENLABS AGENT (default) - Use Twilio phone numbers
  else {
    logger.info(`📞 [Flow Test] ElevenLabs agent detected, looking for Twilio phone numbers`);

    const userTwilioPhones = await db
      .select()
      .from(phoneNumbers)
      .where(and(
        and(eq(phoneNumbers.userId, userId), eq(phoneNumbers.companyId, companyId)),
        inArray(phoneNumbers.status, ["active", "assigned"])
      ));

    if (userTwilioPhones.length === 0) {
      // No user phones, check system pool
      const systemPoolPhones = await db
        .select()
        .from(phoneNumbers)
        .where(and(
          and(eq(phoneNumbers.isSystemPool, true), or(isNull(phoneNumbers.companyId), eq(phoneNumbers.companyId, companyId))),
          eq(phoneNumbers.status, "available"),
          isNull(phoneNumbers.userId)
        ))
        .orderBy(desc(phoneNumbers.purchasedAt));

      const availableSystemPhones = systemPoolPhones.filter(p => !connectedPhoneIdSet.has(p.id));

      if (availableSystemPhones.length > 0) {
        // Check which pool numbers are currently busy (have active calls)
        const activeCallRows = await db
          .select({ fromNumber: calls.fromNumber })
          .from(calls)
          .where(and(inArray(calls.status, ['pending', 'initiated', 'ringing', 'in-progress']), eq(calls.companyId, companyId)));
        const busyNumbers = new Set(activeCallRows.map(r => r.fromNumber).filter(Boolean));
        const freeSystemPhones = availableSystemPhones.filter(p => !busyNumbers.has(p.phoneNumber));

        if (freeSystemPhones.length === 0) {
          if (queueEntryId) {
            await failQueue("All phone numbers became busy. Please try again.");
            throw new FlowTestHttpError(503, {
              error: "No phone numbers available",
              message: "All phone numbers became busy. Please try again in a moment.",
            });
          }
          const [queueEntry] = await db.insert(flowTestQueue).values({
            userId,
            companyId,
            flowId: flow.id,
            toPhone: phoneNumber,
            status: 'waiting',
          }).returning();
          const [{ count }] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(flowTestQueue)
            .where(and(eq(flowTestQueue.status, 'waiting'), eq(flowTestQueue.companyId, companyId)));
          logger.info(`⏳ [Flow Test] All pool numbers busy, queued as entry ${queueEntry.id} (position ${count})`);
          throw new FlowTestHttpError(202, {
            queued: true,
            queueEntryId: queueEntry.id,
            position: count ?? 1,
            message: "All phone numbers are currently busy. You have been added to the queue.",
          });
        }

        fromPhone = freeSystemPhones[0];
        logger.info(`📞 [Flow Test] Using system pool Twilio phone: [redacted]`);
      } else {
        throw new FlowTestHttpError(400, {
          error: "No phone number available",
          message: "You need to purchase or rent a phone number before making test calls. Visit the Phone Numbers page to get started.",
          needsPhonePurchase: true,
          provider: 'twilio',
        });
      }
    } else {
      const availableUserPhones = userTwilioPhones.filter(p => !connectedPhoneIdSet.has(p.id));
      if (availableUserPhones.length > 0) {
        fromPhone = availableUserPhones[0];
        logger.info(`📞 [Flow Test] Using Twilio phone: [redacted]`);
      } else {
        const agentNames = await getConnectedAgentNames(userTwilioPhones.map(p => p.id));
        throw new FlowTestHttpError(409, {
          error: "Phone number conflict",
          message: `All your Twilio phone numbers are connected to incoming agents (${agentNames}). A phone number can only be used for either incoming calls OR outbound campaigns/tests, not both.`,
          suggestion: "Please purchase a new Twilio phone number for outbound calls, or disconnect one of your numbers from the incoming agent first.",
          conflictType: "incoming_connection",
          connectedAgentName: agentNames,
        });
      }
    }
  }
  return fromPhone;
}

export async function findFlowTestCampaignWarning({
  companyId,
  fromPhone,
}: {
  companyId: string;
  fromPhone: any;
}): Promise<FlowTestCampaignWarning> {
  let activeCampaignWarning: { message: string; campaignName: string } | null = null;

  const activeCampaignsUsingPhone = await db
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.phoneNumberId, fromPhone.id),
        eq(campaigns.companyId, companyId),
        inArray(campaigns.status, ["running", "active", "in_progress"])
      )
    );

  if (activeCampaignsUsingPhone.length > 0) {
    const campaignNames = activeCampaignsUsingPhone.map(c => c.name).join(", ");
    activeCampaignWarning = {
      message: `Warning: This phone number is currently being used by an active campaign (${campaignNames}). Running this test may affect the ongoing campaign.`,
      campaignName: campaignNames
    };
    logger.info(`⚠️ [Flow Test] Phone [redacted] is attached to active campaign(s): ${campaignNames}`);
  }
  return activeCampaignWarning;
}
