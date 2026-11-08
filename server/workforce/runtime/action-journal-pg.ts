/**
 * Postgres action journal: the journal row and the action it records are written in one transaction.
 *
 * Pure: no driver import. Every query goes through the injected SqlExecutor, which must be a single connection
 * (a pg Client or a checked-out pool client), so BEGIN, the action, the journal INSERT and COMMIT share it.
 * - runActionWithJournal(executor, { journalRow, action }): BEGIN, runs action(executor), INSERTs journalRow into
 *   action_journal, COMMITs, and returns the action's result. Any error, from the action or the INSERT, ROLLBACKs,
 *   so neither the action's writes nor the journal row are kept without the other.
 *
 * Column names come from the journalRow keys and must match a strict identifier pattern. Values are bound as $1, $2, ...
 */

import type { SqlExecutor } from './pg-store.ts'

const TABLE = 'action_journal'
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/

export interface JournalRunOptions<T> {
  /**
   * Column name to value for the action_journal row. Written in the same transaction as the action. A function is
   * called with the action's result, so the row can record the outcome. Its columns are checked after the action runs,
   * inside the transaction, so a bad row still rolls the action back.
   */
  journalRow: Readonly<Record<string, unknown>> | ((result: T) => Readonly<Record<string, unknown>>)
  /** The action. It receives the same single-connection executor, so its writes sit inside the transaction. */
  action: (db: SqlExecutor) => Promise<T>
}

function journalInsert(row: Readonly<Record<string, unknown>>): { insert: string; values: unknown[] } {
  const columns = Object.keys(row)
  if (columns.length === 0) throw new Error('action journal: journalRow is empty')
  for (const column of columns) {
    if (!IDENTIFIER.test(column)) throw new Error(`invalid action journal column: ${column}`)
  }
  const values = columns.map((column) => {
    const value = row[column]
    return value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value
  })
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ')
  return { insert: `INSERT INTO ${TABLE} (${columns.join(', ')}) VALUES (${placeholders})`, values }
}

export async function runActionWithJournal<T>(db: SqlExecutor, options: JournalRunOptions<T>): Promise<T> {
  // A static row is checked before BEGIN, so a bad row never opens a transaction.
  const staticRow = typeof options.journalRow === 'function' ? null : journalInsert(options.journalRow)

  await db.query('BEGIN', [])
  try {
    const result = await options.action(db)
    const row = typeof options.journalRow === 'function' ? options.journalRow(result) : options.journalRow
    const { insert, values } = staticRow ?? journalInsert(row)
    await db.query(insert, values)
    await db.query('COMMIT', [])
    return result
  } catch (error) {
    try {
      await db.query('ROLLBACK', [])
    } catch {
      // The original error is the one worth reporting.
    }
    throw error
  }
}
