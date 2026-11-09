/**
 * Stub definitions for declared tool ids that have no handler group. Each one returns { status: 'not_implemented' }
 * with a reason that names the missing table or channel. No query runs, and no table is invented here (see
 * tools/READ_TOOLS.md). A stub is not a real handler: the handler-map ratchet does not count it as bound.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolSchema } from '../runtime/tool-registry.ts';

export const MISSING_TOOL_TIMEOUT_MS = 10000;

export interface MissingNotImplemented {
  status: 'not_implemented';
  reason: string;
}

const notImplemented = (reason: string): MissingNotImplemented => ({ status: 'not_implemented', reason });

// ---- inventory.stock.list ---------------------------------------------------------------------------------------------

const STOCK_LIST_REASON =
  'Stock levels are not bound: inventory.stock.list is not mapped to the inventory_items table (migrations/0014, ' +
  'company_id scoped). That mapping is still open, so nothing was read.';

const stockListInput = z.object({ limit: z.number().int().min(1).max(50).optional() }).strict();
const stockListSchema: ToolSchema = { limit: { type: 'number' } };

/** Every tool id in this module. Each one is declared by a role and has no real handler yet. */
export const GROUP_MISSING_TOOL_IDS: readonly string[] = ['inventory.stock.list'];

/** Registry definitions for the missing ids. Each has an explicit schema, risk, access and timeout. */
export function createGroupMissingToolDefinitions(): ToolDefinition[] {
  return [
    {
      id: 'inventory.stock.list',
      risk: 'low',
      access: 'read',
      schema: stockListSchema,
      timeoutMs: MISSING_TOOL_TIMEOUT_MS,
      handler: (params: Record<string, unknown>) => {
        stockListInput.parse(params);
        return notImplemented(STOCK_LIST_REASON);
      },
    },
  ];
}
