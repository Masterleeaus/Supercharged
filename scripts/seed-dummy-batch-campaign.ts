import { db } from "../server/db";
import { campaigns, calls, users, agents } from "../shared/schema";
import { eq, or } from "drizzle-orm";

async function seedDummyBatchCampaign() {
  console.log("🌱 Assigning all dummy campaigns to demo@diploy.in and seeding batch data...");

  // Find demo@diploy.in user or first user
  let [user] = await db.select().from(users).where(eq(users.email, "demo@diploy.in")).limit(1);
  if (!user) {
    [user] = await db.select().from(users).limit(1);
  }

  if (!user) {
    console.error("❌ No user found in the database.");
    process.exit(1);
  }

  console.log(`👤 Using user: ${user.email} (${user.id})`);

  // Find or create an agent for this user
  let [agent] = await db.select().from(agents).where(eq(agents.userId, user.id)).limit(1);
  if (!agent) {
    const [newAgent] = await db.insert(agents).values({
      userId: user.id,
      name: "Demo AI Agent",
      type: "outbound",
      systemPrompt: "You are a helpful AI assistant.",
      firstMessage: "Hello, calling regarding your inquiry.",
      telephonyProvider: "twilio-openai",
    }).returning();
    agent = newAgent;
  }

  // Update ALL existing campaigns to be owned by demo@diploy.in user and have batchJobId
  const allCampaigns = await db.select().from(campaigns);
  for (const c of allCampaigns) {
    const batchId = c.batchJobId || `btcal_demo_${c.id.slice(0, 8)}`;
    const totalCount = 43;
    const completedCount = 41;
    const failedCount = 2;

    await db.update(campaigns).set({
      userId: user.id,
      agentId: agent.id,
      batchJobId: batchId,
      batchJobStatus: "completed",
      status: "completed",
      totalContacts: totalCount,
      completedCalls: completedCount,
      successfulCalls: completedCount,
      failedCalls: failedCount,
    }).where(eq(campaigns.id, c.id));

    // Reset and seed exact 43 calls (41 completed, 2 failed)
    await db.delete(calls).where(eq(calls.campaignId, c.id));
    const callInserts = [];
    for (let i = 1; i <= totalCount; i++) {
      const isFailed = i > completedCount;
      callInserts.push({
        userId: user.id,
        agentId: agent.id,
        campaignId: c.id,
        status: isFailed ? "failed" : "completed",
        duration: isFailed ? 0 : Math.floor(Math.random() * 120) + 15,
        toNumber: `+1555000${String(i).padStart(4, "0")}`,
        startedAt: new Date(Date.now() - (totalCount - i) * 60000),
        endedAt: new Date(Date.now() - (totalCount - i) * 60000 + 30000),
      });
    }
    await db.insert(calls).values(callInserts);
  }

  console.log("\n---------------------------------------------------");
  console.log(`🎉 All campaigns updated & assigned to ${user.email}!`);
  const updatedList = await db.select().from(campaigns);
  for (const c of updatedList) {
    console.log(`- ${c.name} (${c.id}) => User: ${c.userId}, Batch ID: ${c.batchJobId}`);
  }
  console.log("---------------------------------------------------\n");

  process.exit(0);
}

seedDummyBatchCampaign().catch((err) => {
  console.error("❌ Error seeding dummy batch campaign:", err);
  process.exit(1);
});
