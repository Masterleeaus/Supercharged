/*
 * Authority ladder: a pure, table-driven decision for whether an agent action may
 * run, must wait for owner approval, or is refused.
 *
 * Autonomy tiers are the owner's decided model: assist, suggest, auto, predictive.
 * They are listed least to most autonomous, in the same rank order as
 * role.schema.ts (AUTONOMY_RANK). The Interaction Engine's six-level AuthorityLevel
 * is collapsed into these four tiers. The table below is original code. No database,
 * request, or environment access happens here.
 *
 * Risk tiers are NOT in the engine. The engine scores risk (RiskEngine) but has no
 * tier concept, so the four risk tiers below are defined here. The caller assigns
 * the tier. See PORT-NOTES.md.
 */

/** Action risk, lowest to highest. The caller assigns the tier for each action. */
export const RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/**
 * Autonomy tiers, least to most autonomous. Same rank order as role.schema.ts AUTONOMY_RANK.
 * Anything else fails closed.
 */
export const AUTONOMY_LEVELS = ['assist', 'suggest', 'auto', 'predictive'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/**
 * Tool access: whether a tool only reads data or can write or send. A tool that declares no
 * access is treated as 'write' (fail closed). Any other value is refused at every tier.
 */
export const TOOL_ACCESS = ['read', 'write'] as const;
export type ToolAccess = (typeof TOOL_ACCESS)[number];

/**
 * The verified human actor. This is an actor, not a tier: the tool registry passes it as
 * the autonomy of a human caller. No role may declare it, and an agent may not claim it.
 */
export const HUMAN_ACTOR = 'user_only' as const;
export type HumanActor = typeof HUMAN_ACTOR;

export type LadderDecision = 'allow' | 'require_approval' | 'deny';

/**
 * Cell outcomes in the ladder table.
 *  - allow:     run now.
 *  - approval:  run only with a verified owner approval; otherwise require_approval.
 *  - deny:      refuse, whatever the approval state.
 */
export type LadderCell = 'allow' | 'approval' | 'deny';

export interface LadderInput {
  /** Risk tier of the action. Anything outside RISK_TIERS fails closed. */
  tier: unknown;
  /** Acting agent's autonomy tier, or HUMAN_ACTOR for a human. Anything else fails closed. */
  autonomy: unknown;
  /**
   * True only when a human approval has been verified for this exact action
   * (for example, a signed decision that checks out). Any value other than the
   * boolean true counts as not approved.
   */
  humanApproved?: unknown;
  /** True when the actor is a verified human rather than an agent. Defaults to false. */
  actorIsHuman?: unknown;
  /**
   * The tool's access: 'read' or 'write'. Absent (undefined) means 'write'. Any other value
   * fails closed. Only the suggest tier looks at it; other tiers use the same cells for both.
   */
  access?: unknown;
}

export interface LadderResult {
  decision: LadderDecision;
  reason: string;
  tier: RiskTier | null;
  autonomy: AutonomyLevel | HumanActor | null;
}

/** One row of the ladder. `reason` is the text returned when the row decides an action. */
export interface LadderRow {
  autonomy: AutonomyLevel;
  tier: RiskTier;
  /** The cell for a write tool, or for any tool when the row has no `read` cell. */
  cell: LadderCell;
  reason: string;
  /** The cell for a read tool, when the row differs by access. Only the suggest rows set it. */
  read?: { cell: LadderCell; reason: string };
}

/**
 * The ladder, one row per (autonomy tier, risk tier). Read it top to bottom.
 *
 *  assist       Responds only when asked. Runs no tools, at any tier, read or write.
 *  suggest      Watches and notifies with a suggestion. Read tools run at every tier,
 *               with no approval gate. Write tools are denied at every tier, because
 *               a suggest agent cannot write or send.
 *  auto         Runs set daily tasks itself. Low and medium run. High waits for
 *               owner approval. Critical waits for owner approval.
 *  predictive   Prepares tomorrow and next week from data. Same cells as auto.
 *
 * Critical ceiling: no critical cell is ever `allow`. A critical action is never run
 * without a verified owner approval, and under auto it is never run unattended.
 * Money movement, outbound customer messages and record deletion must be assigned the
 * critical tier by the caller, because the ladder cannot see an action's category.
 *
 * HUMAN_ACTOR (user_only) is handled by HUMAN_CELLS below, not by this table.
 */
export const LADDER: readonly LadderRow[] = [
  // assist
  { autonomy: 'assist', tier: 'low', cell: 'deny', reason: 'assist agents respond only when asked and cannot run tools' },
  { autonomy: 'assist', tier: 'medium', cell: 'deny', reason: 'assist agents respond only when asked and cannot run tools' },
  { autonomy: 'assist', tier: 'high', cell: 'deny', reason: 'assist agents respond only when asked and cannot run tools' },
  { autonomy: 'assist', tier: 'critical', cell: 'deny', reason: 'assist agents respond only when asked and cannot run tools' },
  // suggest (write tools: deny; read tools: the `read` cell)
  { autonomy: 'suggest', tier: 'low', cell: 'deny', reason: 'suggest agents cannot write or send', read: { cell: 'allow', reason: 'low-risk read run by a suggest agent' } },
  { autonomy: 'suggest', tier: 'medium', cell: 'deny', reason: 'suggest agents cannot write or send', read: { cell: 'allow', reason: 'medium-risk read run by a suggest agent' } },
  { autonomy: 'suggest', tier: 'high', cell: 'deny', reason: 'suggest agents cannot write or send', read: { cell: 'allow', reason: 'high-risk read run by a suggest agent' } },
  { autonomy: 'suggest', tier: 'critical', cell: 'deny', reason: 'suggest agents cannot write or send', read: { cell: 'allow', reason: 'critical-risk read run by a suggest agent' } },
  // auto
  { autonomy: 'auto', tier: 'low', cell: 'allow', reason: 'low-risk action run by an auto agent' },
  { autonomy: 'auto', tier: 'medium', cell: 'allow', reason: 'medium-risk action run by an auto agent' },
  { autonomy: 'auto', tier: 'high', cell: 'approval', reason: 'high-risk action needs a verified owner approval' },
  { autonomy: 'auto', tier: 'critical', cell: 'approval', reason: 'critical-risk action needs a verified owner approval' },
  // predictive
  { autonomy: 'predictive', tier: 'low', cell: 'allow', reason: 'low-risk action run by a predictive agent' },
  { autonomy: 'predictive', tier: 'medium', cell: 'allow', reason: 'medium-risk action run by a predictive agent' },
  { autonomy: 'predictive', tier: 'high', cell: 'approval', reason: 'high-risk action needs a verified owner approval' },
  { autonomy: 'predictive', tier: 'critical', cell: 'approval', reason: 'critical-risk action needs a verified owner approval' },
];

/**
 * The verified human actor (HUMAN_ACTOR). A human performs low, medium and high actions
 * directly. A critical action still needs a verified owner approval.
 */
const HUMAN_CELLS: Readonly<Record<RiskTier, { cell: LadderCell; reason: string }>> = {
  low: { cell: 'allow', reason: 'verified human actor performs a low-risk action' },
  medium: { cell: 'allow', reason: 'verified human actor performs a medium-risk action' },
  high: { cell: 'allow', reason: 'verified human actor performs a high-risk action' },
  critical: { cell: 'approval', reason: 'critical-risk action needs a verified owner approval, even for a human actor' },
};

const LADDER_INDEX: ReadonlyMap<string, LadderRow> = new Map(
  LADDER.map((row) => [`${row.autonomy}|${row.tier}`, row] as const),
);

export function isRiskTier(value: unknown): value is RiskTier {
  return typeof value === 'string' && (RISK_TIERS as readonly string[]).includes(value);
}

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

/**
 * The only place a tool's access is read. Absent means 'write'. Any other non-listed value
 * returns null, which the caller turns into a denial.
 */
function resolveAccess(raw: unknown): ToolAccess | null {
  if (raw === undefined) return 'write';
  return typeof raw === 'string' && (TOOL_ACCESS as readonly string[]).includes(raw) ? (raw as ToolAccess) : null;
}

/**
 * Decide an action against the ladder. Unknown tiers, unknown access values, unknown autonomy
 * values, an agent claiming HUMAN_ACTOR, and missing table rows all deny. The function never throws on bad input.
 */
export function evaluateAuthority(input: LadderInput): LadderResult {
  if (!isRiskTier(input.tier)) {
    return { decision: 'deny', reason: 'unknown risk tier; failing closed', tier: null, autonomy: null };
  }

  const access = resolveAccess(input.access);
  if (access === null) {
    return { decision: 'deny', reason: 'unknown tool access; failing closed', tier: input.tier, autonomy: null };
  }

  const actorIsHuman = input.actorIsHuman === true;
  const approved = input.humanApproved === true;

  let cell: LadderCell;
  let reason: string;
  let autonomy: AutonomyLevel | HumanActor;

  if (input.autonomy === HUMAN_ACTOR) {
    if (!actorIsHuman) {
      return { decision: 'deny', reason: 'user_only is a verified human actor; an agent cannot claim it', tier: input.tier, autonomy: null };
    }
    cell = HUMAN_CELLS[input.tier].cell;
    reason = HUMAN_CELLS[input.tier].reason;
    autonomy = HUMAN_ACTOR;
  } else {
    if (!isAutonomyLevel(input.autonomy)) {
      return { decision: 'deny', reason: 'unknown autonomy level; failing closed', tier: input.tier, autonomy: null };
    }
    const row = LADDER_INDEX.get(`${input.autonomy}|${input.tier}`);
    if (!row) {
      return { decision: 'deny', reason: 'no ladder row for this tier and autonomy; failing closed', tier: input.tier, autonomy: input.autonomy };
    }
    cell = row.cell;
    reason = row.reason;
    if (row.read && access === 'read') {
      cell = row.read.cell;
      reason = row.read.reason;
    }
    autonomy = input.autonomy;
  }

  const base = { tier: input.tier, autonomy };

  switch (cell) {
    case 'allow':
      return { decision: 'allow', reason, ...base };
    case 'approval':
      return approved
        ? { decision: 'allow', reason: `${reason}; owner approval verified`, ...base }
        : { decision: 'require_approval', reason, ...base };
    case 'deny':
      return { decision: 'deny', reason, ...base };
  }
}
