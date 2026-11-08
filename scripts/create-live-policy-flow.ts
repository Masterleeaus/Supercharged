import fetch, { Headers } from 'node-fetch';

const BASE_URL = 'https://callcenter.cloudams.com';
const EMAIL = 'info@cloudsoftwaretech.com';
const PASSWORD = 'Delta2026!@#$';

async function createRemotePolicyFlow() {
  console.log(`🔑 Attempting login to ${BASE_URL}...`);

  // Step 1: Login to get session / JWT token / cookies
  let loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: EMAIL, email: EMAIL, password: PASSWORD }),
  });

  if (!loginRes.ok) {
    // Try alternative login endpoint /api/auth/login
    loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
  }

  // Extract cookies from response header
  const rawCookies = loginRes.headers.raw()['set-cookie'] || [];
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');

  let loginData: any = {};
  try {
    loginData = await loginRes.json();
  } catch (e) {
    console.log('Login body non-JSON response');
  }

  console.log(`Status: ${loginRes.status}`);
  console.log(`Cookies obtained: ${cookieHeader || 'None'}`);
  console.log('Login Response Data:', loginData);

  if (!loginRes.ok) {
    console.error('❌ Login failed. Please check credentials or login URL.');
    process.exit(1);
  }

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (cookieHeader) {
    authHeaders['Cookie'] = cookieHeader;
  }
  if (loginData.token) {
    authHeaders['Authorization'] = `Bearer ${loginData.token}`;
  }

  // Step 2: Define Flow Payload
  const userPrompt = `
## POLICY INQUIRY RULES

You have access to the "get_policy_details" tool. When a caller asks about their policy details:

1. Ask them to provide their Policy Number (e.g., starting with "AMWGK").
2. Once they provide it, call the \`get_policy_details\` tool with the policy number.
3. Read the policy information returned from the API back to the user clearly and concisely.
`.trim();

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

  // Step 3: Create Agent First (or Flow directly)
  console.log('🤖 Creating Agent on Live Platform...');
  const agentRes = await fetch(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Policy Support Agent',
      type: 'flow',
      systemPrompt: userPrompt,
      firstMessage: 'Hello! Thank you for calling Policy Customer Support. How can I assist you with your insurance policy today?',
      language: 'en',
      llmModel: 'gpt-4o-mini',
      openaiVoice: 'alloy',
      isActive: true,
    }),
  });

  let createdAgent: any = {};
  if (agentRes.ok) {
    createdAgent = await agentRes.json();
    console.log(`✅ Agent Created! ID: ${createdAgent.id}`);
  } else {
    console.warn(`⚠️ Agent creation status ${agentRes.status}, proceeding to flow creation...`);
  }

  // Step 4: Create Flow via API
  console.log('🌊 Creating Flow on Live Platform...');
  const flowRes = await fetch(`${BASE_URL}/api/flow-automation/flows`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Policy Inquiry Dynamic Webhook Flow',
      description: 'Dynamically fetches policy details from appcloudams API using policyNumber',
      nodes: nodes,
      edges: edges,
      agentId: createdAgent.id || undefined,
      isActive: true,
    }),
  });

  const flowData = await flowRes.json();
  console.log(`Flow creation status: ${flowRes.status}`);
  console.log('Flow Creation Response:', flowData);

  if (flowRes.ok) {
    console.log('\n🎉 SUCCESS! Created Policy Flow on Live Dashboard:');
    console.log(`   - Flow ID: ${flowData.id}`);
    console.log(`   - Flow Name: ${flowData.name}`);
    if (createdAgent.id) console.log(`   - Agent ID: ${createdAgent.id}`);
  } else {
    console.error('❌ Failed to create flow. Check API response above.');
  }
}

createRemotePolicyFlow().catch(err => {
  console.error('Execution error:', err);
});
