import { db } from '../server/db';
import { calls, sipCalls, leads, campaigns } from '../shared/schema';
import { eq, or } from 'drizzle-orm';
import { CallSyncService } from '../server/services/call-sync';
import { CRMLeadProcessor } from '../server/engines/crm/lead-processor.service';

async function main() {
  const identifier = process.argv[2];
  
  if (!identifier) {
    console.error("❌ Please provide a call ID or ElevenLabs conversation ID.");
    console.error("Usage: npx tsx scripts/test-sip-lead-process.ts <call_id_or_conversation_id>");
    process.exit(1);
  }

  console.log(`🔍 Searching for call record with identifier: "${identifier}"`);

  try {
    // 1. Find call in calls table
    let callRecord = await db.select().from(calls).where(
      or(
        eq(calls.id, identifier),
        eq(calls.elevenLabsConversationId, identifier)
      )
    ).limit(1).then(res => res[0]);

    let isSipCallsTable = false;
    let sipCallRecord = null;

    if (!callRecord) {
      // 2. Find in sip_calls table
      sipCallRecord = await db.select().from(sipCalls).where(
        or(
          eq(sipCalls.id, identifier),
          eq(sipCalls.elevenlabsConversationId, identifier)
        )
      ).limit(1).then(res => res[0]);

      if (sipCallRecord) {
        isSipCallsTable = true;
        console.log(`✅ Found record in 'sip_calls' table.`);
      }
    } else {
      console.log(`✅ Found record in 'calls' table.`);
    }

    if (!callRecord && !sipCallRecord) {
      console.error(`❌ No call record found in 'calls' or 'sip_calls' for: ${identifier}`);
      process.exit(1);
    }

    const targetId = isSipCallsTable ? sipCallRecord.id : callRecord.id;
    const conversationId = isSipCallsTable ? sipCallRecord.elevenlabsConversationId : callRecord.elevenLabsConversationId;

    console.log(`\n--- Call Details ---`);
    console.log(`ID: ${targetId}`);
    console.log(`Conversation ID: ${conversationId || 'N/A'}`);
    console.log(`Status: ${isSipCallsTable ? sipCallRecord.status : callRecord.status}`);
    console.log(`Duration: ${isSipCallsTable ? sipCallRecord.durationSeconds : callRecord.duration}s`);
    console.log(`Phone: ${isSipCallsTable ? `${sipCallRecord.fromNumber} -> ${sipCallRecord.toNumber}` : callRecord.phoneNumber}`);
    console.log(`Transcript length: ${isSipCallsTable ? (sipCallRecord.transcript ? JSON.stringify(sipCallRecord.transcript).length : 0) : (callRecord.transcript?.length || 0)}`);

    console.log(`\n🔄 1. Running CallSyncService...`);
    const syncService = new CallSyncService();
    const syncResult = await syncService.syncCall(targetId);
    console.log(`Sync Result:`, JSON.stringify(syncResult, null, 2));

    // Reload record after sync
    if (isSipCallsTable) {
      sipCallRecord = await db.select().from(sipCalls).where(eq(sipCalls.id, targetId)).limit(1).then(res => res[0]);
    } else {
      callRecord = await db.select().from(calls).where(eq(calls.id, targetId)).limit(1).then(res => res[0]);
    }

    console.log(`\n💳 2. Testing Credit Deduction & Lead Generation...`);
    const currentStatus = isSipCallsTable ? sipCallRecord.status : callRecord.status;
    const currentDuration = isSipCallsTable ? sipCallRecord.durationSeconds : callRecord.duration;

    if (currentStatus !== 'completed' && currentStatus !== 'done') {
      console.warn(`⚠️ Warning: Call status is "${currentStatus}", not "completed". Processing may be skipped.`);
    }

    if (isSipCallsTable) {
      console.log(`Deducting credits via deductSipCallCredits...`);
      const { deductSipCallCredits } = await import('../server/services/credit-service');
      const creditRes = await deductSipCallCredits(targetId, currentDuration || 0, 'elevenlabs-sip');
      console.log(`Credit Deduction Result:`, JSON.stringify(creditRes, null, 2));

      console.log(`Processing lead via CRMLeadProcessor.processSipCall...`);
      const leadRes = await CRMLeadProcessor.processSipCall(targetId);
      console.log(`CRM Lead Processor Result:`, JSON.stringify(leadRes, null, 2));
    } else {
      console.log(`Deducting credits via deductCallCreditsForElevenLabs...`);
      const { deductCallCreditsForElevenLabs } = await import('../server/routes/webhooks/helpers');
      const creditRes = await deductCallCreditsForElevenLabs(targetId, currentDuration || 0);
      console.log(`Credit Deduction Result:`, JSON.stringify(creditRes, null, 2));

      console.log(`Processing lead via CRMLeadProcessor.processElevenLabsTwilioCall...`);
      const leadRes = await CRMLeadProcessor.processElevenLabsTwilioCall(targetId);
      console.log(`CRM Lead Processor Result:`, JSON.stringify(leadRes, null, 2));
    }

    if (leadRes?.leadId) {
      console.log(`\n🔍 Directly querying Lead from Database by ID: ${leadRes.leadId}`);
      const [lead] = await db.select().from(leads).where(eq(leads.id, leadRes.leadId)).limit(1);
      if (lead) {
        console.log(`✅ Lead Found by ID!`);
        console.log(`- Lead ID: ${lead.id}`);
        console.log(`- Name: ${lead.firstName} ${lead.lastName}`);
        console.log(`- Phone: ${lead.phoneNumber}`);
        console.log(`- AI Category: ${lead.aiCategory}`);
        console.log(`- Score: ${lead.engagementScore}`);
      } else {
        console.log(`❌ Lead not found in DB by ID: ${leadRes.leadId}`);
      }
    } else if (phone) {
      const cleanPhone = phone.replace(/[^\d]/g, '');
      console.log(`\n🔍 Verifying Lead in Database for clean phone: ${cleanPhone}`);
      const matchedLeads = await db.select().from(leads).limit(200);
      const lead = matchedLeads.find(l => l.phoneNumber && l.phoneNumber.replace(/[^\d]/g, '') === cleanPhone);
      
      if (lead) {
        console.log(`✅ Lead Found by phone search!`);
        console.log(`- Lead ID: ${lead.id}`);
        console.log(`- Name: ${lead.firstName} ${lead.lastName}`);
        console.log(`- Phone: ${lead.phoneNumber}`);
        console.log(`- AI Category: ${lead.aiCategory}`);
        console.log(`- Score: ${lead.engagementScore}`);
      } else {
        console.log(`❌ No Lead found in database for clean phone: ${cleanPhone}`);
      }
    }

  } catch (err: any) {
    console.error("❌ Execution Error:", err.message, err.stack);
  }
  
  process.exit(0);
}

main();
