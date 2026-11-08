import fetch from 'node-fetch';

const BASE_URL = 'https://callcenter.cloudams.com';
const EMAIL = 'info@cloudsoftwaretech.com';
const PASSWORD = 'Delta2026!@#$';

async function setupLivePolicyFlowAndAgent() {
  console.log(`🔑 Logging in to ${BASE_URL}/api/auth/login...`);
  
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  const rawCookies = loginRes.headers.raw()['set-cookie'] || [];
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');
  const loginData: any = await loginRes.json();

  if (!loginRes.ok || !loginData.token) {
    console.error('❌ Login failed:', loginRes.status, loginData);
    process.exit(1);
  }

  console.log('✅ Login successful!');
  console.log(`👤 User ID: ${loginData.user.id}`);
  console.log(`📧 User Email: ${loginData.user.email}`);

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'Authorization': `Bearer ${loginData.token}`
  };

  const userPrompt = `
## POLICY INQUIRY RULES

You have access to the "get_policy_details" tool. When a caller asks about their policy details:

1. Ask them to provide their Policy Number (e.g., starting with "AMWGK").
2. Once they provide it, call the \`get_policy_details\` tool with the policy number.
3. Read the policy information returned from the API back to the user clearly and concisely.
`.trim();

  // 1. Define Nodes & Edges
  const nodes = [
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

  const edges = [
    { id: 'e-start-webhook', source: 'start-node', target: 'policy-webhook-node' },
    { id: 'e-webhook-end', source: 'policy-webhook-node', target: 'end-node' },
  ];

  // 2. Create Flow First (without agentId)
  console.log('\n🌊 Creating Flow on Live Platform...');
  const flowRes = await fetch(`${BASE_URL}/api/flow-automation/flows`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Policy Inquiry Dynamic Webhook Flow',
      description: 'Dynamically fetches policy details from appcloudams API using policyNumber',
      nodes: nodes,
      edges: edges,
      isActive: true,
    }),
  });

  const flowData: any = await flowRes.json();
  if (!flowRes.ok) {
    console.error('❌ Flow creation failed:', flowRes.status, flowData);
    process.exit(1);
  }
  console.log(`✅ Flow Created Successfully! ID: ${flowData.id}`);

  // 3. Create Agent with flowId
  console.log('\n🤖 Creating AI Agent on Live Platform...');
  const agentRes = await fetch(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Policy Support Agent',
      type: 'flow',
      flowId: flowData.id,
      systemPrompt: userPrompt,
      firstMessage: 'Hello! Thank you for calling Policy Customer Support. How can I assist you with your insurance policy today?',
      voiceTone: 'Professional, helpful, and concise',
      personality: 'Friendly policy inquiry assistant',
      language: 'en',
      llmModel: 'gpt-4o-mini',
      openaiVoice: 'alloy',
      isActive: true,
      telephonyProvider: 'twilio_openai'
    }),
  });

  const agentData: any = await agentRes.json();
  if (!agentRes.ok) {
    console.error('❌ Agent creation failed:', agentRes.status, agentData);
    process.exit(1);
  }
  console.log(`✅ Agent Created Successfully! ID: ${agentData.id}`);

  // 4. Update / Save Flow with agentId to compile system prompt and tools
  console.log('\n⚡ Linking Agent & Compiling Flow Tools...');
  const updateRes = await fetch(`${BASE_URL}/api/flow-automation/flows/${flowData.id}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Policy Inquiry Dynamic Webhook Flow',
      nodes: nodes,
      edges: edges,
      agentId: agentData.id,
      isActive: true,
    }),
  });

  const updatedFlowData: any = await updateRes.json();

  console.log('\n🎉 ALL DONE! Live Setup Completed Successfully!');
  console.log('====================================================');
  console.log(`   - Live Dashboard URL: ${BASE_URL}`);
  console.log(`   - Flow ID: ${updatedFlowData.id || flowData.id}`);
  console.log(`   - Flow Name: ${updatedFlowData.name || flowData.name}`);
  console.log(`   - Agent ID: ${agentData.id}`);
  console.log(`   - Agent Name: ${agentData.name}`);
  console.log(`   - Webhook Endpoint: https://appcloudams.com/api/policies/{{policyNumber}}`);
  console.log(`   - Compiled Tools Count: ${updatedFlowData.compiledTools ? updatedFlowData.compiledTools.length : 'Compiled'}`);
  console.log('====================================================');
}

setupLivePolicyFlowAndAgent().catch(console.error);
