/**
 * Plan gate for staff replies (HasHumanAgentsFn). Replaces the always-allow default in mount.ts (O-07).
 *
 * Rule used here (documented fallback):
 *   A company may receive human-agent replies when it has at least one active staff member with the agent role.
 *   "Active" means users.is_active is true and users.is_deleted is false. The query filters on company_id.
 *
 * Why this rule: Desk has no plan field that says whether human agents are included. users.plan_type is 'free' or
 * 'pro' per user, not per company, and no column or table maps a plan to human agents. The PHP reference
 * (ChatbotHelper::planAllowsHumanAgent, chatbot_human_agent on the plan) has no Desk equivalent yet. When a plan
 * flag exists, replace the lookup in createDrizzleActiveAgentLookup and keep createHasHumanAgents as it is.
 *
 * Fail closed: a non-UUID company id, a missing lookup, a non-true result, or a thrown error all return false.
 * The error goes to onError and is never returned or logged here.
 */
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../shared/schema.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { HasHumanAgentsFn } from "../agent-routes/agent-handlers.ts";

/** users.role value that counts as a human agent. */
export const HUMAN_AGENT_ROLE = "agent";

/** Port over the staff table. Implementations must filter by companyId. */
export interface ActiveAgentLookup {
  /** True when the company has at least one active, non-deleted user with HUMAN_AGENT_ROLE. */
  hasActiveAgent(companyId: string): Promise<boolean>;
}

export interface HasHumanAgentsDeps {
  lookup: ActiveAgentLookup;
  /** Receives lookup errors. They are not returned to callers. */
  onError?: (err: unknown) => void;
}

export function createHasHumanAgents(deps: HasHumanAgentsDeps): HasHumanAgentsFn {
  return async (companyId: string): Promise<boolean> => {
    try {
      const scoped = requireCompanyId(companyId);
      return (await deps.lookup.hasActiveAgent(scoped)) === true;
    } catch (err: unknown) {
      deps.onError?.(err);
      return false;
    }
  };
}

/** Drizzle implementation over users. Company-scoped by company_id, one row at most. */
export function createDrizzleActiveAgentLookup(db: NodePgDatabase<any>): ActiveAgentLookup {
  return {
    async hasActiveAgent(companyId: string): Promise<boolean> {
      const rows = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.companyId, companyId),
            eq(schema.users.role, HUMAN_AGENT_ROLE),
            eq(schema.users.isActive, true),
            eq(schema.users.isDeleted, false),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}
