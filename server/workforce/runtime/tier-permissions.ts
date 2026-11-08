/*
 * Tier permissions: the owner's definition of what each autonomy tier may do, as a table,
 * and a check that the authority ladder (server/modules/approvals/authority-ladder.ts)
 * agrees with that table at every risk level.
 *
 * The ladder is read only here. Nothing in this file changes it. A disagreement is reported,
 * not resolved.
 *
 * Owner definitions:
 *  - assist:     responds only when asked and runs no tools.
 *  - suggest:    watches, reads data it can see, never writes or sends, and notifies with suggestions.
 *  - auto:       runs set daily tasks without approval. Money, customer sends and record deletes
 *                always need owner approval.
 *  - predictive: prepares ahead from data with the same risk rules as auto. Sensitive actions
 *                still need approval.
 *
 * Field meanings:
 *  - canRunTools:     the tier may run tools at all.
 *  - canReadData:     the tier may run read tools.
 *  - canWrite:        the tier may run write tools (write meaning any change that is not a read).
 *  - canSend:         the tier may send to a customer. Auto and predictive can do it only with a
 *                     verified owner approval; the ladder and policy evaluator enforce that.
 *  - canMoveMoney:    same as canSend, for money movement.
 *  - canDelete:       same as canSend, for record deletion.
 *  - runsUnattended:  the tier acts without a person starting each action.
 *
 * The owner's risk rule for auto and predictive is that high and critical actions need
 * owner approval. The ladder states it too. The owner gives no risk rule for suggest reads.
 */

import { evaluateAuthority, type AutonomyLevel, type LadderDecision, type RiskTier, RISK_TIERS, type ToolAccess } from '../../modules/approvals/authority-ladder.ts';

export interface TierPermissions {
  canRunTools: boolean;
  canReadData: boolean;
  canWrite: boolean;
  canSend: boolean;
  canMoveMoney: boolean;
  canDelete: boolean;
  runsUnattended: boolean;
}

/** Tiers in the same order as AUTONOMY_LEVELS (least to most autonomous). */
export const TIER_PERMISSIONS: Readonly<Record<AutonomyLevel, Readonly<TierPermissions>>> = {
  assist: {
    canRunTools: false,
    canReadData: false,
    canWrite: false,
    canSend: false,
    canMoveMoney: false,
    canDelete: false,
    runsUnattended: false,
  },
  suggest: {
    canRunTools: true,
    canReadData: true,
    canWrite: false,
    canSend: false,
    canMoveMoney: false,
    canDelete: false,
    runsUnattended: true,
  },
  auto: {
    canRunTools: true,
    canReadData: true,
    canWrite: true,
    canSend: true,
    canMoveMoney: true,
    canDelete: true,
    runsUnattended: true,
  },
  predictive: {
    canRunTools: true,
    canReadData: true,
    canWrite: true,
    canSend: true,
    canMoveMoney: true,
    canDelete: true,
    runsUnattended: true,
  },
};

export interface TierDisagreement {
  tier: AutonomyLevel;
  risk: RiskTier;
  access: ToolAccess;
  /** What the owner's table implies for this tier, risk and access. */
  expected: LadderDecision;
  /** What the authority ladder returns for the same tier, risk and access. */
  actual: LadderDecision;
  /** The ladder's own reason string. */
  ladderReason: string;
}

/**
 * What the owner's table implies for one action. The table is tier-level, so the risk rule is
 * the owner's: auto and predictive need approval at high and critical; suggest has no risk gate on reads.
 */
function expectedFromTable(
  tier: AutonomyLevel,
  permissions: Readonly<TierPermissions>,
  risk: RiskTier,
  access: ToolAccess,
): LadderDecision {
  if (!permissions.canRunTools) return 'deny';
  if (access === 'read' && !permissions.canReadData) return 'deny';
  if (access === 'write' && !permissions.canWrite) return 'deny';
  if ((tier === 'auto' || tier === 'predictive') && (risk === 'high' || risk === 'critical')) {
    return 'require_approval';
  }
  return 'allow';
}

/**
 * Compare the table with the real authority ladder for every tier, risk level and tool access.
 * Returns one entry per disagreement. An empty list means the ladder and the table agree.
 * The optional table argument exists so tests can check the reporting itself.
 */
export function checkTierMatchesLadder(
  table: Readonly<Record<AutonomyLevel, Readonly<TierPermissions>>> = TIER_PERMISSIONS,
): TierDisagreement[] {
  const disagreements: TierDisagreement[] = [];
  const tiers = Object.keys(table) as AutonomyLevel[];
  const accesses: ToolAccess[] = ['read', 'write'];
  for (const tier of tiers) {
    for (const risk of RISK_TIERS) {
      for (const access of accesses) {
        const expected = expectedFromTable(tier, table[tier], risk, access);
        const ladder = evaluateAuthority({ tier: risk, autonomy: tier, access, humanApproved: false, actorIsHuman: false });
        if (ladder.decision !== expected) {
          disagreements.push({ tier, risk, access, expected, actual: ladder.decision, ladderReason: ladder.reason });
        }
      }
    }
  }
  return disagreements;
}
