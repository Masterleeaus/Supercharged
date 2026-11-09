/** ElevenLabs test-call path (phone pre-flight and outbound call), moved out of placeFlowTestCall unchanged. */
import { db } from "../../db";
import { phoneNumbers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { PhoneMigrator } from "../../engines/elevenlabs-migration";
import { logger } from "../../utils/logger";
import { FlowTestHttpError, type FlowTestAgent } from "./flow-test-call-types";

export async function prepareElevenLabsTestPhone({
  userId,
  companyId,
  agent,
  fromPhone,
}: {
  userId: string;
  companyId: string;
  agent: FlowTestAgent;
  fromPhone: any;
}) {
  logger.info(`   Using ElevenLabs native outbound call API`);

  const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
  if (!credential) {
    throw new FlowTestHttpError(400, {
      error: "No ElevenLabs credential available",
      message: "Please configure ElevenLabs API keys in the admin settings.",
    });
  }

  let currentPhoneElevenLabsId = fromPhone.elevenLabsPhoneNumberId;

  if (!agent.elevenLabsCredentialId) {
    throw new FlowTestHttpError(400, {
      error: "Agent not assigned to credential",
      message: "This agent is not assigned to an ElevenLabs credential. Please configure ElevenLabs credentials in admin settings.",
    });
  }

  const isSystemPoolNumber = fromPhone.isSystemPool === true && fromPhone.userId === null;
  if (!isSystemPoolNumber && fromPhone.userId !== userId) {
    console.warn(`⚠️ [Flow Test] Phone ${fromPhone.id} does not belong to user ${userId}`);
    throw new FlowTestHttpError(403, {
      error: "Phone number access denied",
      message: "You do not have access to this phone number.",
    });
  }

  // If phone lacks credential, try full migration via PhoneMigrator
  // PhoneMigrator handles proper credential ownership verification and ElevenLabs sync
  if (!fromPhone.elevenLabsCredentialId) {
    logger.warn(`📞 [Flow Test] Phone missing credential - attempting full sync via PhoneMigrator`);
    try {
      const migrationResult = await PhoneMigrator.syncPhoneToAgentCredential(
        fromPhone.id,
        agent.id
      );

      if (migrationResult.success && migrationResult.newElevenLabsPhoneId) {
        logger.info(`✅ [Flow Test] Phone synced successfully via PhoneMigrator`);
        currentPhoneElevenLabsId = migrationResult.newElevenLabsPhoneId;
        // Re-fetch updated phone record to ensure we have correct state
        const [updatedPhone] = await db
          .select()
          .from(phoneNumbers)
          .where(and(eq(phoneNumbers.id, fromPhone.id), eq(phoneNumbers.companyId, companyId)))
          .limit(1);
        if (updatedPhone) {
          fromPhone = updatedPhone;
        }
        // Validate refreshed phone has expected credential after sync
        if (!fromPhone.elevenLabsCredentialId || !fromPhone.elevenLabsPhoneNumberId) {
          console.error(`❌ [Flow Test] Phone sync returned success but DB state invalid`);
          throw new FlowTestHttpError(500, {
            error: "Phone sync inconsistent",
            message: "Phone sync reported success but database state is invalid. Please try again.",
          });
        }
      } else {
        throw new FlowTestHttpError(400, {
          error: "Phone not synced with ElevenLabs",
          message: "This phone number could not be synced with ElevenLabs. Please try syncing from the Phone Numbers page, or purchase a new phone number.",
          suggestion: "Visit Phone Numbers page and click 'Sync to ElevenLabs' for this number.",
        });
      }
    } catch (syncError: any) {
      if (syncError instanceof FlowTestHttpError) throw syncError;
      console.error(`❌ [Flow Test] Phone sync failed:`, syncError);
      throw new FlowTestHttpError(400, {
        error: "Phone sync failed",
        message: "Failed to sync phone number with ElevenLabs. Please try again or purchase a new phone number.",
      });
    }
  } else if (fromPhone.elevenLabsCredentialId !== agent.elevenLabsCredentialId) {
    logger.info(`📞 [Flow Test] Phone credential mismatch detected - initiating migration`);
    logger.info(`   Phone credential: ${fromPhone.elevenLabsCredentialId}`);
    logger.info(`   Agent credential: ${agent.elevenLabsCredentialId}`);

    try {
      const migrationResult = await PhoneMigrator.syncPhoneToAgentCredential(
        fromPhone.id,
        agent.id
      );

      if (!migrationResult.success) {
        console.error(`❌ [Flow Test] Phone migration failed:`, migrationResult.error);
        throw new FlowTestHttpError(400, {
          error: "Phone number migration failed",
          message: "Could not migrate phone number to agent's credential",
        });
      }

      logger.info(`✅ [Flow Test] Phone migrated successfully`);
      logger.info(`   Old ElevenLabs ID: ${migrationResult.oldElevenLabsPhoneId}`);
      logger.info(`   New ElevenLabs ID: ${migrationResult.newElevenLabsPhoneId}`);

      if (!migrationResult.newElevenLabsPhoneId) {
        throw new FlowTestHttpError(400, {
          error: "Phone number migration incomplete",
          message: "Migration succeeded but new ElevenLabs phone ID was not returned",
        });
      }
      currentPhoneElevenLabsId = migrationResult.newElevenLabsPhoneId;

    } catch (migrationError: any) {
      if (migrationError instanceof FlowTestHttpError) throw migrationError;
      console.error(`❌ [Flow Test] Phone migration error:`, migrationError);
      throw new FlowTestHttpError(500, {
        error: "Phone number migration failed",
        message: "Failed to migrate phone number to agent's credential",
      });
    }
  } else {
    logger.info(`✅ [Flow Test] Phone and agent on same credential: ${agent.elevenLabsCredentialId}`);
  }

  // PRE-FLIGHT CHECK 2: Verify phone actually exists on ElevenLabs
  // The database may have a stale elevenLabsPhoneNumberId that no longer exists
  logger.info(`📞 [Flow Test] Verifying phone exists on ElevenLabs...`);
  const verifyResult = await PhoneMigrator.verifyAndEnsurePhoneExists(
    fromPhone.id,
    agent.elevenLabsCredentialId,
    agent.elevenLabsAgentId || undefined // Pass agent ID for assignment after re-import
  );

  if (!verifyResult.success) {
    console.error(`❌ [Flow Test] Phone verification failed:`, verifyResult.error);
    throw new FlowTestHttpError(400, {
      error: "Phone number not available on ElevenLabs",
      message: verifyResult.error || "Could not verify or re-import phone number. Please check your Twilio configuration.",
    });
  }

  if (verifyResult.wasReimported) {
    logger.info(`✅ [Flow Test] Phone was re-imported from Twilio`);
    logger.info(`   New ElevenLabs ID: ${verifyResult.elevenLabsPhoneId}`);
  }

  // Use the verified (or re-imported) phone ID
  currentPhoneElevenLabsId = verifyResult.elevenLabsPhoneId!;
  return { credential, fromPhone, currentPhoneElevenLabsId };
}
