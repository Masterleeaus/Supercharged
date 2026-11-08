import { db } from "../server/db";
import { appointments, users, agents } from "../shared/schema";
import { nanoid } from "nanoid";
import { format, addDays, subDays } from "date-fns";

import { eq } from "drizzle-orm";

async function seed() {
  console.log("Seeding dummy appointments...");
  
  const allUsers = await db.select().from(users).where(eq(users.email, "admin@gmail.com")).limit(1);
  if (allUsers.length === 0) {
    console.log("No users found. Please create a user first.");
    process.exit(0);
  }
  const userId = allUsers[0].id;
  
  const allAgents = await db.select().from(agents).limit(2);
  const agent1 = allAgents[0];
  const agent2 = allAgents[1] || agent1;
  
  const now = new Date();
  
  const dummyAppointments = [
    {
      id: nanoid(),
      userId,
      contactName: "John Doe",
      contactPhone: "+1234567890",
      contactEmail: "john@example.com",
      appointmentDate: format(now, "yyyy-MM-dd"), // Today
      appointmentTime: "23:30", // Setting to late today so it stays in "upcoming"
      duration: 30,
      serviceName: "Consultation",
      status: "scheduled",
      metadata: { source: "openai-agent", agentId: agent1?.id, agentName: agent1?.name || "Support Bot" }
    },
    {
      id: nanoid(),
      userId,
      contactName: "Jane Smith",
      contactPhone: "+0987654321",
      contactEmail: "jane@example.com",
      appointmentDate: format(addDays(now, 1), "yyyy-MM-dd"), // Tomorrow
      appointmentTime: "10:00",
      duration: 60,
      serviceName: "Follow up",
      status: "scheduled",
      metadata: { source: "elevenlabs", agentId: agent2?.id, agentName: agent2?.name || "Sales Bot" }
    },
    {
      id: nanoid(),
      userId,
      contactName: "Bob Johnson",
      contactPhone: "+1122334455",
      contactEmail: "bob@example.com",
      appointmentDate: format(subDays(now, 1), "yyyy-MM-dd"), // Yesterday
      appointmentTime: "16:15",
      duration: 45,
      serviceName: "Onboarding",
      status: "completed",
      metadata: { source: "openai-agent", agentId: agent1?.id, agentName: agent1?.name || "Support Bot" }
    }
  ];

  for (const apt of dummyAppointments) {
    await db.insert(appointments).values(apt);
    console.log(`Inserted appointment for ${apt.contactName}`);
  }
  
  console.log("Seeding complete!");
  process.exit(0);
}

seed().catch(console.error);
