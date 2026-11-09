/**
 * Backfill: charge users for completed calls that never had credits deducted.
 *
 * Originally a one-shot for the Twilio+OpenAI engine; now a thin wrapper
 * around the shared credit-backfill-monitor service so all engines can be
 * scanned and backfilled with one tool. Idempotent — `deductCallCredits` is
 * safe to re-run.
 *
 * Usage:
 *   npx tsx server/scripts/backfill-twilio-openai-credits.ts
 *   npx tsx server/scripts/backfill-twilio-openai-credits.ts --dry-run
 *   npx tsx server/scripts/backfill-twilio-openai-credits.ts --user <userId>
 *   npx tsx server/scripts/backfill-twilio-openai-credits.ts --engine twilio-openai
 *   npx tsx server/scripts/backfill-twilio-openai-credits.ts --engines twilio-openai,plivo-openai
 *   npx tsx server/scripts/backfill-twilio-openai-credits.ts --since-days 30
 */
import {
  ALL_ENGINES,
  executeBackfill,
  type BackfillEngine,
} from "../services/credit-backfill-monitor";
import { logger } from '../utils/logger.ts';

function parseArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parseEngines(raw: string | undefined): BackfillEngine[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as BackfillEngine[];
  for (const e of list) {
    if (!ALL_ENGINES.includes(e)) {
      throw new Error(
        `Unknown engine '${e}'. Valid: ${ALL_ENGINES.join(", ")}`,
      );
    }
  }
  return list;
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filterUserId = parseArg(args, "--user");
  // Default to the historical behaviour of this script: twilio-openai only,
  // unless the operator opts into a wider sweep.
  const engineArg = parseArg(args, "--engine");
  const enginesArg = parseArg(args, "--engines");
  const sinceDaysArg = parseArg(args, "--since-days");

  let engines: BackfillEngine[] | undefined;
  if (args.includes("--all-engines")) {
    engines = [...ALL_ENGINES];
  } else if (enginesArg) {
    engines = parseEngines(enginesArg);
  } else if (engineArg) {
    engines = parseEngines(engineArg);
  } else {
    engines = ["twilio-openai"];
  }

  const sinceDays = sinceDaysArg ? Number(sinceDaysArg) : undefined;

  logger.info(
    `[Backfill] Starting credit backfill (engines=${engines!.join(",")}, dryRun=${dryRun}${
      filterUserId ? `, user=${filterUserId}` : ""
    }${sinceDays ? `, sinceDays=${sinceDays}` : ""})`,
  );

  const result = await executeBackfill({
    engines,
    dryRun,
    userId: filterUserId,
    sinceDays,
  });

  for (const e of result.engines) {
    logger.info(`[Backfill] ${e.engine}:`);
    logger.info(`  Unbilled candidates:   ${e.scanned}`);
    logger.info(`  Charged:               ${e.charged}`);
    logger.info(`  Already deducted:      ${e.alreadyDeducted}`);
    logger.info(`  Insufficient credits:  ${e.insufficientCredits}`);
    logger.info(`  Errors:                ${e.errors}`);
    logger.info(`  Total credits taken:   ${e.totalCreditsDeducted}`);
  }

  logger.info("[Backfill] Totals:");
  logger.info(`  Scanned: ${result.totals.scanned}`);
  logger.info(`  Charged: ${result.totals.charged}`);
  logger.info(`  Credits: ${result.totals.totalCreditsDeducted}`);
  logger.info(`  Errors:  ${result.totals.errors}`);

  process.exit(result.totals.errors > 0 ? 1 : 0);
}

run().catch((err) => {
  logger.error("[Backfill] Fatal error:", err);
  process.exit(1);
});
