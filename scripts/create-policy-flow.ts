import { db } from '../server/db';
import { flows, agents } from '../shared/schema';
import { OpenAIVoiceAgentCompiler } from '../server/services/openai-voice-agent';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

async function seedPolicyFlow() {
  console.log('🚀 Creating Policy Details Inquiry Flow & Sample Agent...');

  // 1. Get or create a user ID (using first user in database)
  const userResult = await db.execute(`SELECT id FROM users LIMIT 1`);
  if (!userResult.rows || userResult.rows.length === 0) {
    throw new Error('No user found in the database. Please create a user first.');
  }
  const userId = (userResult.rows[0] as any).id;
  console.log(`👤 Using User ID: ${userId}`);

  const flowId = `flow-${nanoid(10)}`;
  const agentId = `agent-${nanoid(10)}`;

  // 2. Define Flow Nodes
  const nodes: any[] = [
    {
      id: 'start-node',
      type: 'message',
      position: { x: 250, y: 50 },
      data: {
        type: 'message',
        label: 'Greeting',
        config: {
          type: 'message',
          message: 'Hello! Thank you for calling Policy Customer Support. How can I assist you with your insurance policy today?',
          waitForResponse: true,
        },
      },
    },
    {
      id: 'policy-webhook-node',
      type: 'webhook',
      position: { x: 250, y: 180 },
      data: {
        type: 'webhook',
        label: 'Get Policy Details',
        config: {
          type: 'webhook',
          url: 'https://appcloudams.com/api/policies/{{policyNumber}}',
          method: 'GET',
          headers: {
            'X-API-Key': process.env.STRIPE_SECRET_KEY ?? '',
            'Content-Type': 'application/json',
          },
          payload: {},
          description: 'Fetch policy details such as status, coverage, and holder info using a policy number.',
        },
      },
    },
    {
      id: 'end-node',
      type: 'end',
      position: { x: 250, y: 310 },
      data: {
        type: 'end',
        label: 'End Call',
        config: {
          type: 'end',
          message: 'Thank you for contacting us. Have a wonderful day!',
        },
      },
    },
  ];

  // 3. Define Flow Edges
  const edges: any[] = [
    {
      id: 'e-start-webhook',
      source: 'start-node',
      target: 'policy-webhook-node',
    },
    {
      id: 'e-webhook-end',
      source: 'policy-webhook-node',
      target: 'end-node',
    },
  ];

  // 4. Compile system prompt and tools using OpenAIVoiceAgentCompiler
  const userPrompt = `
## POLICY INQUIRY RULES

You have access to the "get_policy_details" tool (or the policy lookup webhook). When a caller asks about their policy details:

1. Ask them to provide their Policy Number (e.g., starting with "AMWGK").
2. Once they provide it, call the get_policy_details / webhook tool with the policy number.
3. Read the policy information returned from the API back to the user clearly and concisely.
`.trim();

  const compilationConfig = {
    agentName: 'Policy Details Agent',
    userPrompt: userPrompt,
    voice: 'alloy',
  };

  const compiled = OpenAIVoiceAgentCompiler.compileFlow(nodes, edges, compilationConfig);

  // 5. Create the Flow in DB
  const [createdFlow] = await db
    .insert(flows)
    .values({
      id: flowId,
      userId: userId,
      name: 'Policy Inquiry Dynamic Webhook Flow',
      description: 'Dynamically fetches policy details from appcloudams API using policyNumber',
      nodes: nodes,
      edges: edges,
      agentId: agentId,
      isActive: true,
      compiledSystemPrompt: compiled.systemPrompt,
      compiledFirstMessage: compiled.firstMessage || 'Hello! Thank you for calling Policy Support. How can I assist you with your policy today?',
      compiledStates: compiled.conversationStates,
      compiledTools: compiled.tools,
    })
    .returning();

  console.log(`✅ Flow Created successfully! ID: ${createdFlow.id}`);

  // 6. Create or link Agent in DB
  const [createdAgent] = await db
    .insert(agents)
    .values({
      id: agentId,
      userId: userId,
      name: 'Policy Support Agent',
      type: 'flow',
      flowId: createdFlow.id,
      telephonyProvider: 'custom-voice-engine',
      systemPrompt: userPrompt,
      firstMessage: 'Hello! Thank you for calling Policy Customer Support. How can I assist you with your insurance policy today?',
      language: 'en',
      llmModel: 'gpt-4o-mini',
      openaiVoice: 'alloy',
      isActive: true,
    })
    .returning();

  console.log(`✅ Agent Created successfully! ID: ${createdAgent.id}`);
  console.log('\n🎉 Complete! Flow and Agent setup finished:');
  console.log(`   - Flow ID: ${createdFlow.id}`);
  console.log(`   - Flow Name: ${createdFlow.name}`);
  console.log(`   - Agent ID: ${createdAgent.id}`);
  console.log(`   - Agent Name: ${createdAgent.name}`);
  console.log(`   - Webhook URL Configured: https://appcloudams.com/api/policies/{{policyNumber}}`);

  process.exit(0);
}

seedPolicyFlow().catch((err) => {
  console.error('❌ Error creating sample flow script:', err);
  process.exit(1);
});
