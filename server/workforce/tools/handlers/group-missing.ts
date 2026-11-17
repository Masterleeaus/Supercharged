/**
 * Handlers for declared tool ids that were outside the four handler groups. Each id has an explicit zod input schema, a
 * registry schema, a risk tier and an access class.
 *
 * inventory.stock.list is a real, read-only handler bound to inventory_items (migrations/0014, company_id scoped). Every
 * query runs with company_id = $1, rows from another company are dropped again in JS, and the output is an explicit
 * allow-list capped at MISSING_MAX_ROWS.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../../services/ai-runtime/types.ts';
import type { SqlExecutor } from '../../runtime/pg-store.ts';
import type { ToolDefinition, ToolHandlerContext, ToolSchema } from '../../runtime/tool-registry.ts';

export const MISSING_TOOL_TIMEOUT_MS = 10000;
export const MISSING_MAX_ROWS = 50;

// ---- inventory.stock.list ---------------------------------------------------------------------------------------------

const stockListInput = z.object({ limit: z.number().int().min(1).max(MISSING_MAX_ROWS).optional() }).strict();
const stockListSchema: ToolSchema = { limit: { type: 'number' } };

export class MissingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingInputError';
  }
}

interface StockRow {
  id: unknown;
  companyId: unknown;
  name: unknown;
  sku: unknown;
  unitLabel: unknown;
  quantity: unknown;
  reorderLevel: unknown;
}

const stockShape = (row: StockRow) => ({
  id: row.id,
  name: row.name,
  sku: row.sku,
  unitLabel: row.unitLabel,
  quantity: Number(row.quantity),
  reorderLevel: Number(row.reorderLevel),
});

/**
 * Lists stock items for the caller's company. db is the read executor. Without one the handler refuses rather than
 * guess. The SQL text is fixed here, and the caller's values only go in as $n parameters.
 */
export async function inventoryStockList(
  input: unknown,
  context: Pick<ToolHandlerContext, 'companyId'>,
  db: SqlExecutor | undefined,
) {
  const companyId: CompanyId = requireCompanyId(context.companyId);
  const parsed = stockListInput.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.') || '(input)'],
    );
    // Field names only. Values are never echoed back.
    throw new MissingInputError(`invalid input: ${[...new Set(fields)].join(', ')}`);
  }
  if (!db) throw new Error('inventory.stock.list needs a database executor');
  const cap = parsed.data.limit ?? MISSING_MAX_ROWS;
  const result = await db.query(
    `SELECT id, company_id AS "companyId", name, sku, unit_label AS "unitLabel",
            quantity, reorder_level AS "reorderLevel"
       FROM inventory_items
      WHERE company_id = $1
      ORDER BY name, id
      LIMIT $2`,
    [companyId, cap + 1],
  );
  const own = (result.rows as unknown as StockRow[]).filter((row) => row.companyId === companyId);
  const kept = own.slice(0, cap).map(stockShape);
  return { rows: kept, count: kept.length, truncated: own.length > cap, maxRows: MISSING_MAX_ROWS };
}

/** Every tool id in this module. */
export const GROUP_MISSING_TOOL_IDS: readonly string[] = ['inventory.stock.list'];

/** Registry definitions for the ids in this module. db is the read executor. */
export function createGroupMissingToolDefinitions(db?: SqlExecutor): ToolDefinition[] {
  return [
    {
      id: 'inventory.stock.list',
      risk: 'low',
      access: 'read',
      schema: stockListSchema,
      timeoutMs: MISSING_TOOL_TIMEOUT_MS,
      handler: (params, context) => inventoryStockList(params, context, db),
    },
  ];
}
