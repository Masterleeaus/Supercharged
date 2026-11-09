/** Custom Voice Engine (FreeSWITCH ESL) test-call path, moved out of placeFlowTestCall unchanged. */
import { db } from "../../db";
import { flowExecutions } from "@shared/schema";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "../../utils/logger";
import { FlowTestHttpError, type FlowTestAgent, type FlowTestFlow, type FlowTestCompleteQueue, type FlowTestFailQueue, type FlowTestCampaignWarning } from "./flow-test-call-types";

export async function placeCustomVoiceEngineFlowTestCall({
  userId,
  companyId,
  flow,
  agent,
  phoneNumber,
  clientIp,
  fromPhone,
  activeCampaignWarning,
  completeQueue,
  failQueue,
}: {
  userId: string;
  companyId: string;
  flow: FlowTestFlow;
  agent: FlowTestAgent;
  phoneNumber: string;
  clientIp?: string;
  fromPhone: any;
  activeCampaignWarning: FlowTestCampaignWarning;
  completeQueue: FlowTestCompleteQueue;
  failQueue: FlowTestFailQueue;
}): Promise<Record<string, unknown>> {
  logger.info(`   Using Custom Voice Engine via FreeSWITCH ESL`);

  try {
    // Find an online FreeSWITCH node
    const nodesResult = await db.execute(sql`
      SELECT * FROM ve_freeswitch_nodes WHERE status = 'online' ORDER BY created_at ASC
    `);

    const nodes = nodesResult.rows as any[];
    if (nodes.length === 0) {
      throw new FlowTestHttpError(400, {
        error: "No active FreeSWITCH nodes",
        message: "Please add and configure an online FreeSWITCH node in the Voice Engine admin settings page before testing.",
      });
    }

    const node = nodes[0];

    // Let's create a session ID
    const sessionUuid = nanoid();

    // Check if the agent exists in ve_voice_agents to satisfy foreign key constraint
    const checkAgentInVe = await db.execute(sql`
      SELECT id FROM ve_voice_agents WHERE id = ${agent.id} LIMIT 1
    `);
    const isVeAgent = checkAgentInVe.rows.length > 0;
    const dbAgentId = isVeAgent ? agent.id : null;
    const metadata: Record<string, any> = !isVeAgent ? { agentId: agent.id } : {};
    if (clientIp) {
      metadata.clientIp = clientIp;
    }

    // Create a session in ve_sessions database table
    await db.execute(sql`
      INSERT INTO ve_sessions (
        id, user_id, agent_id, from_number, to_number, direction, status, channel_uuid, metadata
      ) VALUES (
        ${sessionUuid}, ${userId}, ${dbAgentId}, ${fromPhone.phoneNumber || 'FreeSWITCH'}, ${phoneNumber}, 'outbound', 'initializing', ${sessionUuid}, ${Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null}
      )
    `);

    // Create flow execution record
    try {
      await db.insert(flowExecutions).values({
        id: nanoid(),
        companyId,
        callId: sessionUuid,
        flowId: flow.id,
        currentNodeId: null,
        status: 'running',
        variables: {},
        pathTaken: [],
        startedAt: new Date(),
        metadata: {
          campaignId: null,
          campaignName: null,
          contactPhone: phoneNumber,
          nativeExecution: true,
          telephonyProvider: 'custom-voice-engine',
          testCall: true,
        },
      });
    } catch (flowExecError: any) {
      console.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
    }

    const { importPlugin } = await import('../utils/plugin-import');
    const { EslConnection } = await importPlugin('plugins/custom-voice-engine/services/freeswitch/esl-connection');

    const eslHost = node.esl_host || node.eslHost;
    const eslPort = node.esl_port || node.eslPort;
    const eslPassword = node.esl_password || node.eslPassword || 'ClueCon';

    const esl = new EslConnection({
      host: eslHost,
      port: eslPort,
      password: eslPassword,
      reconnect: false,
    });

    // Register error handler to prevent uncaught exceptions
    esl.on('error', (err: any) => {
      console.error('[ESL] Client error during flow test call:', err.message);
    });

    await esl.connect();

    // Originate string using Sofia SIP configuration
    let activeGateway: any = null;
    if (userId) {
      const userGatewayResult = await db.execute(sql`
        SELECT name, proxy, username, password FROM user_sip_gateways WHERE user_id = ${userId} AND is_active = true LIMIT 1
      `);
      activeGateway = (userGatewayResult.rows as any[])[0];
    }

    const gatewayProxy = activeGateway ? activeGateway.proxy : 'testhr.pstn.twilio.com';
    const isTwilio = !activeGateway || gatewayProxy.includes('twilio.com');

    let formattedTo = !phoneNumber.startsWith('+') ? `+${phoneNumber}` : phoneNumber;
    if (!isTwilio && formattedTo.startsWith('+')) {
      formattedTo = formattedTo.substring(1);
    }
    const dialString = `sofia/external/${formattedTo}@${gatewayProxy}`;
    const destination = `${formattedTo} XML public`;

    const os = await import('os');
    const getContainerIp = () => {
      if (process.env.VE_AUDIO_WS_IP) {
        return process.env.VE_AUDIO_WS_IP;
      }
      if (process.env.PUBLIC_IP) {
        return process.env.PUBLIC_IP;
      }
      const interfaces = os.networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name] || []) {
          if (net.family === 'IPv4' && !net.internal) {
            if (net.address.startsWith('10.') || net.address.startsWith('172.') || net.address.startsWith('192.168.')) {
              return net.address;
            }
          }
        }
      }
      return '127.0.0.1';
    };
    const containerIp = getContainerIp();

    const rawPhone = fromPhone.phoneNumber || 'FreeSWITCH';
    let callerId = (rawPhone !== 'FreeSWITCH' && !rawPhone.startsWith('+')) ? `+${rawPhone}` : rawPhone;
    if (!isTwilio && callerId.startsWith('+')) {
      callerId = callerId.substring(1);
    }

    const options = {
      origination_uuid: sessionUuid,
      origination_caller_id_number: callerId,
      origination_caller_id_name: callerId,
      effective_caller_id_number: callerId,
      effective_caller_id_name: callerId,
      sip_from_uri: `sip:${callerId}@${gatewayProxy}`,
      sip_invite_req_uri: `sip:${formattedTo}@${gatewayProxy}`,
      ve_audio_ws_url: `ws://${containerIp}:${process.env.PORT || '5000'}/voice-engine/ws/audio`,
      ...(activeGateway?.username && { sip_auth_username: activeGateway.username }),
      ...(activeGateway?.password && { sip_auth_password: activeGateway.password }),
    };

    // Trigger originate
    await esl.originate(dialString, destination, options);
    await esl.disconnect();

    logger.info(`✅ [Flow Test] Custom Voice Engine outbound call initiated via FreeSWITCH node ${node.name}`);

    await completeQueue(sessionUuid);
    return {
      success: true,
      callId: sessionUuid,
      conversationId: sessionUuid,
      flowId: flow.id,
      flowName: flow.name,
      fromNumber: 'FreeSWITCH',
      toNumber: phoneNumber,
      message: "Test call initiated successfully via Custom Voice Engine. FreeSWITCH is dialing your number.",
      engine: 'custom_voice_engine',
      ...(activeCampaignWarning && { warning: activeCampaignWarning }),
    };
  } catch (cveError: any) {
    if (cveError instanceof FlowTestHttpError) throw cveError;
    console.error(`❌ [Flow Test] Custom Voice Engine call error:`, cveError);
    await failQueue("Failed to initiate call via Custom Voice Engine");
    throw new FlowTestHttpError(400, {
      error: "Call initiation failed",
      message: `Failed to initiate call via Custom Voice Engine: ${cveError.message}`,
    });
  }
}
