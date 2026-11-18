/**
 * Pre-boot guard entry.
 *
 * ES imports are hoisted and evaluated in source order before any code in the
 * importing module runs. server/index.ts imports this file as its first
 * statement, so the VoltOps check runs before any module that loads
 * @voltagent is evaluated. Do not move the check back into index.ts.
 */
import { assertNoVoltOpsKeys } from "./integrations/voltagent/guard.ts";

assertNoVoltOpsKeys();
