/**
 * Flag readers for the money domain. Each one goes through readFlag from the contracts, so a flag is on only when
 * its value is exactly "true". Every flag defaults off.
 */
import { CONTRACT_FLAGS, readFlag, type FlagEnv } from "../../contracts/index.ts";

export const isPaymentsEnabled = (env: FlagEnv): boolean => readFlag(CONTRACT_FLAGS.PAYMENTS_ENABLED, env);
export const isBnplEnabled = (env: FlagEnv): boolean => readFlag(CONTRACT_FLAGS.BNPL_ENABLED, env);
export const isPricingRulesEnabled = (env: FlagEnv): boolean => readFlag(CONTRACT_FLAGS.PRICING_RULES_ENABLED, env);
export const isRentalHireEnabled = (env: FlagEnv): boolean => readFlag(CONTRACT_FLAGS.RENTAL_HIRE_ENABLED, env);
