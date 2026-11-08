import fetch from 'node-fetch';

const BASE_URL = 'https://callcenter.cloudams.com';
const EMAIL = 'info@cloudsoftwaretech.com';
const PASSWORD = 'Delta2026!@#$';

async function updateAndLinkAgent() {
  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: EMAIL, email: EMAIL, password: PASSWORD }),
  });

  const rawCookies = loginRes.headers.raw()['set-cookie'] || [];
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');
  const loginData: any = await loginRes.json();

  console.log('Login Response User ID:', loginData.user?.id);
  console.log('Login Token:', loginData.token);

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

  // Create Agent
  console.log('🤖 Creating Agent...');
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
      telephonyProvider: 'twilio-openai'
    }),
  });

  const agentData: any = await agentRes.json();
  console.log('Agent Creation Result:', agentRes.status, agentData);

  const flowId = 'mstZQwbHNW1BnVJ5tk6Q1';

  if (agentData.id) {
    console.log(`🔗 Linking Flow ${flowId} with Agent ${agentData.id}...`);
    const flowUpdateRes = await fetch(`${BASE_URL}/api/flow-automation/flows/${flowId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        agentId: agentData.id,
        isActive: true
      }),
    });

    const updatedFlow = await flowUpdateRes.json();
    console.log('Updated Flow Data Status:', flowUpdateRes.status);
    console.log('Compiled System Prompt created?:', !!updatedFlow.compiledSystemPrompt);
  }
}

updateAndLinkAgent().catch(console.error);
