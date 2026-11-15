/**
 * SIP Credit Guard Service
 * 
 * Protects against SIP credit abuse by automatically disconnecting agents
 * from SIP phone numbers when user credits drop below a threshold.
 * 
 * - Auto-disconnect: After credit deduction, if balance < threshold, disconnect agent from SIP numbers
 * - Block assignment: Prevent agent assignment to SIP numbers when credits are low
 * - Auto-reconnect: When credits are recharged above threshold, reconnect previously disconnected agents
 */

import { logger } from '../utils/logger';
import { db } from '../db';
import { sql } from 'drizzle-orm';

/** Message text of a caught value, for log lines. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SIP_CREDIT_THRESHOLD = 5;

// Row shapes for the raw SQL results read in this file.
type SipPhoneRow = {
  id: string;
  agent_id: string | null;
  phone_number: string;
  external_elevenlabs_phone_id: string | null;
  engine: string | null;
};

type SipDisconnectRow = {
  id: string;
  sip_phone_number_id: string;
  agent_id: string | null;
  phone_number: string;
  agent_exists: boolean;
  engine: string | null;
  external_elevenlabs_phone_id: string | null;
};

type SipCreditUserRow = {
  user_id: string;
  credits: string | number | null;
};

type LowCreditSipPhoneRow = {
  id: string;
  user_id: string;
  phone_number: string;
  external_elevenlabs_phone_id: string | null;
  engine: string | null;
  credits: string | number | null;
};

interface DisconnectedSipPhone {
  sipPhoneId: string;
  agentId: string;
  phoneNumber: string;
  externalElevenLabsPhoneId: string | null;
  engine: string;
}

/**
 * Check if user has enough credits for SIP agent assignment
 */
export async function canAssignSipAgent(userId: string): Promise<{ allowed: boolean; balance: number; threshold: number }> {
  try {
    const result = await db.execute(sql`
      SELECT credits FROM users WHERE id = ${userId} LIMIT 1
    `);
    const balance = Number(result.rows?.[0]?.credits) || 0;
    return {
      allowed: balance >= SIP_CREDIT_THRESHOLD,
      balance,
      threshold: SIP_CREDIT_THRESHOLD,
    };
  } catch (error: unknown) {
    logger.error(`[SIP Credit Guard] Error checking credits for user ${userId}: ${errorText(error)}`);
    return { allowed: true, balance: 0, threshold: SIP_CREDIT_THRESHOLD };
  }
}

/**
 * After credit deduction, check if user's balance dropped below threshold.
 * If so, disconnect agents from all their SIP phone numbers and store the mapping for reconnection.
 */
export async function checkAndDisconnectIfLowCredits(userId: string): Promise<void> {
  try {
    const result = await db.execute(sql`
      SELECT credits FROM users WHERE id = ${userId} LIMIT 1
    `);
    const balance = Number(result.rows?.[0]?.credits) || 0;

    if (balance >= SIP_CREDIT_THRESHOLD) {
      return;
    }

    logger.info(`⚠️ [SIP Credit Guard] User ${userId} credits (${balance}) below threshold (${SIP_CREDIT_THRESHOLD}) - disconnecting SIP agents`);

    const sipPhones = await db.execute(sql`
      SELECT id, agent_id, phone_number, external_elevenlabs_phone_id, engine
      FROM sip_phone_numbers
      WHERE user_id = ${userId}
        AND agent_id IS NOT NULL
        AND is_active = true
    `);

    if (!sipPhones.rows || sipPhones.rows.length === 0) {
      logger.warn(`   [SIP Credit Guard] No active SIP phones with agents found for user`);
      return;
    }

    for (const row of sipPhones.rows) {
      const phone = row as SipPhoneRow;
      try {
        const previousAgentId = phone.agent_id;

        await db.execute(sql`
          UPDATE sip_phone_numbers
          SET agent_id = NULL,
              updated_at = NOW()
          WHERE id = ${phone.id}
        `);

        await db.execute(sql`
          INSERT INTO sip_credit_guard_disconnects (user_id, sip_phone_number_id, agent_id, phone_number, disconnected_at)
          VALUES (${userId}, ${phone.id}, ${previousAgentId}, ${phone.phone_number}, NOW())
          ON CONFLICT (sip_phone_number_id) DO UPDATE SET
            agent_id = ${previousAgentId},
            disconnected_at = NOW(),
            reconnected_at = NULL
        `);

        if (phone.engine === 'elevenlabs-sip' && phone.external_elevenlabs_phone_id) {
          try {
            const { importPlugin } = await import('../utils/plugin-import');
            const { ElevenLabsSipService } = await importPlugin('plugins/sip-engine/services/elevenlabs-sip.service.ts');
            await ElevenLabsSipService.assignAgentToPhoneNumber(
              userId,
              phone.external_elevenlabs_phone_id,
              null
            );
            logger.info(`   ✅ [SIP Credit Guard] Disconnected agent ${previousAgentId} from [redacted] (ElevenLabs)`);
          } catch (elError: unknown) {
            logger.warn(`   ⚠️ [SIP Credit Guard] ElevenLabs disconnect failed for [redacted]: ${errorText(elError)}`);
          }
        } else {
          logger.info(`   ✅ [SIP Credit Guard] Disconnected agent ${previousAgentId} from [redacted] (DB only)`);
        }
      } catch (phoneError: unknown) {
        logger.error(`   ❌ [SIP Credit Guard] Failed to disconnect [redacted]: [redacted]`);
      }
    }

    logger.info(`✅ [SIP Credit Guard] Disconnected ${sipPhones.rows.length} SIP phone(s) for user ${userId}`);
  } catch (error: unknown) {
    logger.error(`❌ [SIP Credit Guard] Error in checkAndDisconnectIfLowCredits: ${errorText(error)}`);
  }
}

/**
 * When credits are recharged, reconnect previously disconnected agents to their SIP phone numbers.
 */
export async function reconnectAfterRecharge(userId: string): Promise<void> {
  try {
    const result = await db.execute(sql`
      SELECT credits FROM users WHERE id = ${userId} LIMIT 1
    `);
    const balance = Number(result.rows?.[0]?.credits) || 0;

    if (balance < SIP_CREDIT_THRESHOLD) {
      return;
    }

    const disconnects = await db.execute(sql`
      SELECT d.id, d.sip_phone_number_id, d.agent_id, d.phone_number,
             sp.external_elevenlabs_phone_id, sp.engine, sp.is_active,
             a.id as agent_exists
      FROM sip_credit_guard_disconnects d
      JOIN sip_phone_numbers sp ON d.sip_phone_number_id = sp.id
      LEFT JOIN agents a ON d.agent_id = a.id
      WHERE d.user_id = ${userId}
        AND d.reconnected_at IS NULL
        AND sp.is_active = true
        AND sp.agent_id IS NULL
    `);

    if (!disconnects.rows || disconnects.rows.length === 0) {
      return;
    }

    logger.info(`🔄 [SIP Credit Guard] User ${userId} recharged to ${balance} credits - reconnecting ${disconnects.rows.length} SIP phone(s)`);

    for (const row of disconnects.rows) {
      const d = row as SipDisconnectRow;
      try {
        if (!d.agent_exists) {
          logger.warn(`   ⚠️ [SIP Credit Guard] Agent ${d.agent_id} no longer exists, skipping [redacted]`);
          await db.execute(sql`
            UPDATE sip_credit_guard_disconnects SET reconnected_at = NOW() WHERE id = ${d.id}
          `);
          continue;
        }

        await db.execute(sql`
          UPDATE sip_phone_numbers
          SET agent_id = ${d.agent_id},
              updated_at = NOW()
          WHERE id = ${d.sip_phone_number_id}
        `);

        if (d.engine === 'elevenlabs-sip' && d.external_elevenlabs_phone_id) {
          try {
            const { importPlugin: importPlugin2 } = await import('../utils/plugin-import');
            const { ElevenLabsSipService } = await importPlugin2('plugins/sip-engine/services/elevenlabs-sip.service.ts');
            await ElevenLabsSipService.assignAgentToPhoneNumber(
              userId,
              d.external_elevenlabs_phone_id,
              d.agent_id
            );
            logger.info(`   ✅ [SIP Credit Guard] Reconnected agent ${d.agent_id} to [redacted] (ElevenLabs)`);
          } catch (elError: unknown) {
            logger.warn(`   ⚠️ [SIP Credit Guard] ElevenLabs reconnect failed for [redacted]: ${errorText(elError)}`);
          }
        } else {
          logger.info(`   ✅ [SIP Credit Guard] Reconnected agent ${d.agent_id} to [redacted] (DB only)`);
        }

        await db.execute(sql`
          UPDATE sip_credit_guard_disconnects SET reconnected_at = NOW() WHERE id = ${d.id}
        `);
      } catch (phoneError: unknown) {
        logger.error(`   ❌ [SIP Credit Guard] Failed to reconnect [redacted]: [redacted]`);
      }
    }

    logger.info(`✅ [SIP Credit Guard] Reconnection complete for user ${userId}`);
  } catch (error: unknown) {
    logger.error(`❌ [SIP Credit Guard] Error in reconnectAfterRecharge: ${errorText(error)}`);
  }
}

/**
 * Startup scan: Check all users with SIP agent assignments and disconnect those below credit threshold.
 * Should be called once during server boot to enforce credit guard on existing assignments.
 */
export async function runStartupCreditGuardScan(): Promise<void> {
  try {
    logger.info(`🔍 [SIP Credit Guard] Running startup scan (threshold: ${SIP_CREDIT_THRESHOLD} credits)...`);

    // Phase 1: Disconnect agents from SIP numbers for users below threshold (DB has agent assigned)
    const usersWithSipAgents = await db.execute(sql`
      SELECT DISTINCT spn.user_id, u.credits
      FROM sip_phone_numbers spn
      JOIN users u ON spn.user_id = u.id
      WHERE spn.agent_id IS NOT NULL
        AND spn.is_active = true
    `);

    let disconnectedCount = 0;
    if (usersWithSipAgents.rows && usersWithSipAgents.rows.length > 0) {
      for (const row of usersWithSipAgents.rows) {
        const user = row as SipCreditUserRow;
        const balance = Number(user.credits) || 0;
        if (balance < SIP_CREDIT_THRESHOLD) {
          logger.info(`   ⚠️ [SIP Credit Guard] User ${user.user_id} has ${balance} credits (below ${SIP_CREDIT_THRESHOLD}) - disconnecting SIP agents`);
          await checkAndDisconnectIfLowCredits(user.user_id);
          disconnectedCount++;
        }
      }
    }

    // Phase 2: Also clear ElevenLabs-side agent assignments for low-credit users
    // even if our DB already has agent_id=NULL (ElevenLabs might still have an agent mapped)
    const lowCreditSipPhones = await db.execute(sql`
      SELECT spn.id, spn.user_id, spn.phone_number, spn.external_elevenlabs_phone_id, spn.engine, u.credits
      FROM sip_phone_numbers spn
      JOIN users u ON spn.user_id = u.id
      WHERE spn.is_active = true
        AND spn.engine = 'elevenlabs-sip'
        AND spn.external_elevenlabs_phone_id IS NOT NULL
        AND spn.agent_id IS NULL
        AND COALESCE(u.credits, 0) < ${SIP_CREDIT_THRESHOLD}
    `);

    let elClearedCount = 0;
    if (lowCreditSipPhones.rows && lowCreditSipPhones.rows.length > 0) {
      for (const row of lowCreditSipPhones.rows) {
        const phone = row as LowCreditSipPhoneRow;
        try {
          const { importPlugin: importPlugin3 } = await import('../utils/plugin-import');
          const { ElevenLabsSipService } = await importPlugin3('plugins/sip-engine/services/elevenlabs-sip.service.ts');
          await ElevenLabsSipService.assignAgentToPhoneNumber(
            phone.user_id,
            phone.external_elevenlabs_phone_id,
            null
          );
          elClearedCount++;
          logger.info(`   ✅ [SIP Credit Guard] Cleared ElevenLabs agent from [redacted] (user ${phone.user_id}, ${phone.credits} credits)`);
        } catch (elError: unknown) {
          logger.warn(`   ⚠️ [SIP Credit Guard] Failed to clear ElevenLabs agent from [redacted]: ${errorText(elError)}`);
        }
      }
    }

    const totalUsers = (usersWithSipAgents.rows?.length || 0);
    logger.info(`✅ [SIP Credit Guard] Startup scan complete: ${totalUsers} user(s) with agents checked, ${disconnectedCount} disconnected, ${elClearedCount} ElevenLabs-side cleared`);
  } catch (error: unknown) {
    logger.error(`❌ [SIP Credit Guard] Startup scan error: ${errorText(error)}`);
  }
}

export const SIP_CREDIT_GUARD_THRESHOLD = SIP_CREDIT_THRESHOLD;
