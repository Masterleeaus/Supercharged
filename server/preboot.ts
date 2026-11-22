/**
 * Pre-boot entry for the VoltOps guard.
 *
 * ES module imports are evaluated depth-first in source order before the importing
 * module's body runs. The guard must therefore run in a module that is imported first
 * by server/index.ts and has no dependencies of its own, so that it executes before any
 * workstream (and any @voltagent import) is evaluated.
 *
 * Do not add imports to this file. Keep it dependency-free.
 */
import { assertNoVoltOpsKeys } from './integrations/voltagent/guard.ts';

assertNoVoltOpsKeys();
