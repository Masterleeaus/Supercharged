'use strict';
/**
 * Batch Processing Utilities
 * 
 * Provides chunked processing for large datasets to prevent memory issues
 * and ensure crash recovery. Used by campaign executor and contact upload.
 */

import { logger } from './logger';
import { db } from '../db';
import { calls, flowExecutions, contacts, campaigns, users } from '@shared/schema';
import type { InsertCall, InsertContact } from '@shared/schema';
import { nanoid } from 'nanoid';
import { inArray } from 'drizzle-orm';

const BATCH_SIZE = 500;
const LOG_INTERVAL = 1000;

/** Above this, omit `.returning()` on successful chunks to avoid holding 100k+ rows in memory. */
export const CONTACT_INSERT_RETAIN_RESULTS_THRESHOLD = 1_500;

export interface BatchCompanyOptions {
  /** Company from the verified session, if the caller has one. Owner records must agree with it. */
  companyId?: string;
}

export interface BatchInsertResult<T> {
  success: boolean;
  inserted: number;
  failed: number;
  results: T[];
  errors: string[];
}

/**
 * Company ids of owning records (campaigns, users), read from the database.
 */
async function loadOwnerCompanies(
  campaignIds: Array<string | null | undefined>,
  userIds: Array<string | null | undefined>
): Promise<{ campaignCompany: Map<string, string | null>; userCompany: Map<string, string | null> }> {
  const campaignCompany = new Map<string, string | null>();
  const userCompany = new Map<string, string | null>();
  const cIds = Array.from(new Set(campaignIds.filter((v): v is string => typeof v === 'string' && v.length > 0)));
  const uIds = Array.from(new Set(userIds.filter((v): v is string => typeof v === 'string' && v.length > 0)));
  if (cIds.length > 0) {
    const rows = await db.select({ id: campaigns.id, companyId: campaigns.companyId })
      .from(campaigns).where(inArray(campaigns.id, cIds));
    for (const row of rows) campaignCompany.set(row.id, row.companyId ?? null);
  }
  if (uIds.length > 0) {
    const rows = await db.select({ id: users.id, companyId: users.companyId })
      .from(users).where(inArray(users.id, uIds));
    for (const row of rows) userCompany.set(row.id, row.companyId ?? null);
  }
  return { campaignCompany, userCompany };
}

/**
 * Resolve one row's company_id. Returns null (refuse the row) when no source has a company,
 * or when the session company and the owner companies disagree.
 */
function resolveRowCompanyId(
  sessionCompanyId: string | undefined,
  ownerCompanyIds: Array<string | null | undefined>
): string | null {
  const found = new Set<string>();
  for (const value of [sessionCompanyId, ...ownerCompanyIds]) {
    if (typeof value === 'string' && value.length > 0) found.add(value);
  }
  return found.size === 1 ? Array.from(found)[0] : null;
}

export interface FlowExecutionInsert {
  callId: string;
  flowId: string;
  campaignId: string;
  campaignName: string;
  contactPhone: string;
  telephonyProvider: string;
}

/**
 * Split an array into chunks of specified size
 */
export function chunkArray<T>(array: T[], chunkSize: number = BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Batch insert call records with chunking and progress logging
 * Returns all successfully created records
 */
export async function batchInsertCalls(
  inserts: InsertCall[],
  logPrefix: string = '[Batch Insert]',
  options: BatchCompanyOptions = {}
): Promise<BatchInsertResult<typeof calls.$inferSelect>> {
  const result: BatchInsertResult<typeof calls.$inferSelect> = {
    success: true,
    inserted: 0,
    failed: 0,
    results: [],
    errors: [],
  };

  if (inserts.length === 0) {
    return result;
  }

  const { campaignCompany, userCompany } = await loadOwnerCompanies(
    inserts.map(c => c.campaignId),
    inserts.map(c => c.userId)
  );
  const callInserts: Array<InsertCall & { companyId: string }> = [];
  for (const row of inserts) {
    const companyId = resolveRowCompanyId(options.companyId, [
      row.campaignId ? campaignCompany.get(row.campaignId) : undefined,
      row.userId ? userCompany.get(row.userId) : undefined,
    ]);
    if (!companyId) {
      result.failed++;
      result.errors.push('Call row refused: company scope unavailable');
      continue;
    }
    callInserts.push({ ...row, companyId });
  }

  if (callInserts.length === 0) {
    result.success = result.failed === 0;
    return result;
  }

  const chunks = chunkArray(callInserts, BATCH_SIZE);
  const totalRecords = callInserts.length;
  let processedCount = 0;

  logger.info(`${logPrefix} Starting batch insert of ${totalRecords} call records in ${chunks.length} chunks`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    try {
      const inserted = await db.insert(calls).values(chunk).returning();
      result.results.push(...inserted);
      result.inserted += inserted.length;
      processedCount += chunk.length;

      if (processedCount % LOG_INTERVAL === 0 || i === chunks.length - 1) {
        logger.info(`${logPrefix} Progress: ${processedCount}/${totalRecords} call records (${Math.round(processedCount / totalRecords * 100)}%)`);
      }
    } catch (error: any) {
      result.failed += chunk.length;
      result.errors.push(`Chunk ${i + 1}: ${error.message}`);
      logger.error(`${logPrefix} ❌ Chunk ${i + 1} failed: ${error.message}`);
      
      for (const callInsert of chunk) {
        try {
          const [singleInsert] = await db.insert(calls).values(callInsert).returning();
          result.results.push(singleInsert);
          result.inserted++;
          result.failed--;
        } catch (singleError: any) {
          logger.warn(`${logPrefix} ⚠️ Single insert failed for [redacted]: ${singleError.message}`);
        }
      }
    }
  }

  result.success = result.failed === 0;
  logger.info(`${logPrefix} ✅ Batch insert complete: ${result.inserted} success, ${result.failed} failed`);
  
  return result;
}

/**
 * Batch insert flow execution records with chunking
 */
export async function batchInsertFlowExecutions(
  executions: FlowExecutionInsert[],
  logPrefix: string = '[Batch Insert]',
  options: BatchCompanyOptions = {}
): Promise<BatchInsertResult<typeof flowExecutions.$inferSelect>> {
  const result: BatchInsertResult<typeof flowExecutions.$inferSelect> = {
    success: true,
    inserted: 0,
    failed: 0,
    results: [],
    errors: [],
  };

  if (executions.length === 0) {
    return result;
  }

  const { campaignCompany } = await loadOwnerCompanies(executions.map(e => e.campaignId), []);
  const scopedExecutions: Array<FlowExecutionInsert & { companyId: string }> = [];
  for (const exec of executions) {
    const companyId = resolveRowCompanyId(options.companyId, [campaignCompany.get(exec.campaignId)]);
    if (!companyId) {
      result.failed++;
      result.errors.push('Flow execution row refused: company scope unavailable');
      continue;
    }
    scopedExecutions.push({ ...exec, companyId });
  }

  if (scopedExecutions.length === 0) {
    result.success = result.failed === 0;
    return result;
  }

  const insertValues = scopedExecutions.map(exec => ({
    id: nanoid(),
    companyId: exec.companyId,
    callId: exec.callId,
    flowId: exec.flowId,
    currentNodeId: null,
    status: 'pending' as const,
    variables: {},
    pathTaken: [],
    metadata: {
      campaignId: exec.campaignId,
      campaignName: exec.campaignName,
      contactPhone: exec.contactPhone,
      nativeExecution: true,
      telephonyProvider: exec.telephonyProvider,
    },
  }));

  const chunks = chunkArray(insertValues, BATCH_SIZE);
  const totalRecords = insertValues.length;
  let processedCount = 0;

  logger.info(`${logPrefix} Starting batch insert of ${totalRecords} flow execution records in ${chunks.length} chunks`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    try {
      const inserted = await db.insert(flowExecutions).values(chunk).returning();
      result.results.push(...inserted);
      result.inserted += inserted.length;
      processedCount += chunk.length;

      if (processedCount % LOG_INTERVAL === 0 || i === chunks.length - 1) {
        logger.info(`${logPrefix} Progress: ${processedCount}/${totalRecords} flow executions (${Math.round(processedCount / totalRecords * 100)}%)`);
      }
    } catch (error: any) {
      result.failed += chunk.length;
      result.errors.push(`Chunk ${i + 1}: ${error.message}`);
      logger.error(`${logPrefix} ❌ Chunk ${i + 1} failed: ${error.message}`);
      
      for (const execInsert of chunk) {
        try {
          const [singleInsert] = await db.insert(flowExecutions).values(execInsert).returning();
          result.results.push(singleInsert);
          result.inserted++;
          result.failed--;
        } catch (singleError: any) {
          logger.warn(`${logPrefix} ⚠️ Single insert failed: ${singleError.message}`);
        }
      }
    }
  }

  result.success = result.failed === 0;
  logger.info(`${logPrefix} ✅ Batch insert complete: ${result.inserted} success, ${result.failed} failed`);
  
  return result;
}

export type BatchInsertContactsOptions = BatchCompanyOptions & {
  /**
   * When false, successful multi-row inserts do not use `.returning()` and `results` stays empty.
   * Use for very large CSV uploads (50k+) to keep memory bounded.
   */
  retainResults?: boolean;
};

/**
 * Batch insert contacts with chunking and progress logging
 */
export async function batchInsertContacts(
  rawContactInserts: InsertContact[],
  logPrefix: string = '[Batch Insert]',
  options: BatchInsertContactsOptions = {}
): Promise<BatchInsertResult<typeof contacts.$inferSelect>> {
  const retainResults = options.retainResults !== false;

  const result: BatchInsertResult<typeof contacts.$inferSelect> = {
    success: true,
    inserted: 0,
    failed: 0,
    results: [],
    errors: [],
  };

  if (rawContactInserts.length === 0) {
    return result;
  }

  const { campaignCompany } = await loadOwnerCompanies(rawContactInserts.map(c => c.campaignId), []);
  const contactInserts: Array<InsertContact & { companyId: string }> = [];
  for (const row of rawContactInserts) {
    const companyId = resolveRowCompanyId(options.companyId, [campaignCompany.get(row.campaignId)]);
    if (!companyId) {
      result.failed++;
      result.errors.push('Contact row refused: company scope unavailable');
      continue;
    }
    contactInserts.push({ ...row, companyId });
  }

  if (contactInserts.length === 0) {
    result.success = result.failed === 0;
    return result;
  }

  const chunks = chunkArray(contactInserts, BATCH_SIZE);
  const totalRecords = contactInserts.length;
  let processedCount = 0;

  logger.info(`${logPrefix} Starting batch insert of ${totalRecords} contacts in ${chunks.length} chunks (retainResults=${retainResults})`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    try {
      if (retainResults) {
        const inserted = await db.insert(contacts).values(chunk).returning();
        result.results.push(...inserted);
        result.inserted += inserted.length;
      } else {
        await db.insert(contacts).values(chunk);
        result.inserted += chunk.length;
      }
      processedCount += chunk.length;

      if (processedCount % LOG_INTERVAL === 0 || i === chunks.length - 1) {
        logger.info(`${logPrefix} Progress: ${processedCount}/${totalRecords} contacts (${Math.round(processedCount / totalRecords * 100)}%)`);
      }
    } catch (error: any) {
      result.failed += chunk.length;
      result.errors.push(`Chunk ${i + 1}: ${error.message}`);
      logger.error(`${logPrefix} ❌ Chunk ${i + 1} failed: ${error.message}`);
      
      for (const contactInsert of chunk) {
        try {
          if (retainResults) {
            const [singleInsert] = await db.insert(contacts).values(contactInsert).returning();
            result.results.push(singleInsert);
          } else {
            await db.insert(contacts).values(contactInsert);
          }
          result.inserted++;
          result.failed--;
        } catch (singleError: any) {
          logger.warn(`${logPrefix} ⚠️ Single insert failed for [redacted]: ${singleError.message}`);
        }
      }
    }
  }

  result.success = result.failed === 0;
  logger.info(`${logPrefix} ✅ Batch insert complete: ${result.inserted} success, ${result.failed} failed`);
  
  return result;
}

/**
 * Process items in chunks with a callback function
 * Useful for any chunked processing that doesn't fit the standard insert pattern
 */
export async function processInChunks<T, R>(
  items: T[],
  processor: (chunk: T[], chunkIndex: number) => Promise<R[]>,
  options: {
    chunkSize?: number;
    logPrefix?: string;
    logInterval?: number;
  } = {}
): Promise<{ results: R[]; processedCount: number; failedCount: number }> {
  const { 
    chunkSize = BATCH_SIZE, 
    logPrefix = '[Chunk Process]',
    logInterval = LOG_INTERVAL 
  } = options;

  const chunks = chunkArray(items, chunkSize);
  const results: R[] = [];
  let processedCount = 0;
  let failedCount = 0;

  logger.info(`${logPrefix} Processing ${items.length} items in ${chunks.length} chunks`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    try {
      const chunkResults = await processor(chunk, i);
      results.push(...chunkResults);
      processedCount += chunk.length;

      if (processedCount % logInterval === 0 || i === chunks.length - 1) {
        logger.info(`${logPrefix} Progress: ${processedCount}/${items.length} (${Math.round(processedCount / items.length * 100)}%)`);
      }
    } catch (error: any) {
      failedCount += chunk.length;
      logger.error(`${logPrefix} ❌ Chunk ${i + 1} failed: ${error.message}`);
    }
  }

  logger.info(`${logPrefix} ✅ Complete: ${processedCount} processed, ${failedCount} failed`);
  
  return { results, processedCount, failedCount };
}
