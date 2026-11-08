/**
 * In-memory agent memory with approval, retention and deletion.
 *
 * Rules:
 * - propose() stores an entry as 'pending'. Pending entries are never returned by recall().
 * - approve() moves a pending entry to 'approved'. Only a human approver can do this:
 *   an approverId starting with 'agent:' is refused with 'human_only'.
 * - recall() returns approved entries for one company and one agent that have not expired.
 *   An entry expires retentionMs after it was proposed, measured with the injected now().
 * - forget() deletes an entry in any status. Entries are only visible to their own company.
 * - Text is refused when it is over MAX_TEXT_LENGTH characters or contains an email address,
 *   a phone-like number or a card-like number ('sensitive_content').
 *
 * Storage is a Map in process memory. Nothing here is persisted.
 */

export type MemorySourceKind = 'record' | 'summary' | 'prediction'

export interface MemorySource {
  kind: MemorySourceKind
  recordId?: string
}

export type MemoryStatus = 'pending' | 'approved'

export interface MemoryEntry {
  id: string
  companyId: string
  agentId: string
  text: string
  source: MemorySource
  status: MemoryStatus
  createdAt: number
  approvedBy: string | null
  approvedAt: number | null
}

export type MemoryErrorCode =
  | 'invalid_company'
  | 'invalid_agent'
  | 'invalid_text'
  | 'text_too_long'
  | 'sensitive_content'
  | 'invalid_source'
  | 'record_id_required'
  | 'invalid_entry'
  | 'invalid_approver'
  | 'human_only'
  | 'not_found'
  | 'not_pending'

export type MemoryResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: MemoryErrorCode }

export interface AgentMemoryOptions {
  now: () => number
  retentionMs: number
}

export interface ProposeInput {
  agentId: string
  text: string
  source: MemorySource
}

export interface AgentMemory {
  propose(companyId: string, input: ProposeInput): MemoryResult<{ entryId: string }>
  approve(companyId: string, entryId: string, approverId: string): MemoryResult<{ entry: MemoryEntry }>
  recall(companyId: string, agentId: string): MemoryResult<{ entries: MemoryEntry[] }>
  forget(companyId: string, entryId: string): MemoryResult
}

export const MAX_TEXT_LENGTH = 500

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
// A run of digits with common phone separators, optionally led by +. At least 8 digits.
const PHONE_RUN = /\+?\d(?:[\s().-]?\d){7,}/g
// A run of digits with optional spaces or dashes between them, 13 to 19 digits in total.
const CARD_RUN = /\d(?:[ -]?\d){12,18}/g

const SOURCE_KINDS: readonly MemorySourceKind[] = ['record', 'summary', 'prediction']

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const hasSensitiveContent = (text: string): boolean => {
  if (EMAIL.test(text)) return true
  for (const match of text.match(PHONE_RUN) ?? []) {
    if (match.replace(/\D/g, '').length >= 8) return true
  }
  for (const match of text.match(CARD_RUN) ?? []) {
    const digits = match.replace(/\D/g, '').length
    if (digits >= 13 && digits <= 19) return true
  }
  return false
}

const copyEntry = (entry: MemoryEntry): MemoryEntry => ({
  ...entry,
  source: { ...entry.source },
})

export function createAgentMemory(options: AgentMemoryOptions): AgentMemory {
  const { now, retentionMs } = options
  const entries = new Map<string, MemoryEntry>()

  const companyOk = (companyId: unknown): companyId is string =>
    typeof companyId === 'string' && UUID.test(companyId)

  const isExpired = (entry: MemoryEntry, at: number): boolean =>
    at - entry.createdAt >= retentionMs

  const propose: AgentMemory['propose'] = (companyId, input) => {
    if (!companyOk(companyId)) return { ok: false, error: 'invalid_company' }
    if (!input || !isNonEmptyString(input.agentId)) return { ok: false, error: 'invalid_agent' }
    if (!isNonEmptyString(input.text)) return { ok: false, error: 'invalid_text' }
    if (input.text.length > MAX_TEXT_LENGTH) return { ok: false, error: 'text_too_long' }
    if (hasSensitiveContent(input.text)) return { ok: false, error: 'sensitive_content' }

    const source = input.source
    if (!source || !SOURCE_KINDS.includes(source.kind)) {
      return { ok: false, error: 'invalid_source' }
    }
    if (source.kind === 'record' && !isNonEmptyString(source.recordId)) {
      return { ok: false, error: 'record_id_required' }
    }

    const id = crypto.randomUUID()
    entries.set(id, {
      id,
      companyId,
      agentId: input.agentId,
      text: input.text,
      source: source.kind === 'record'
        ? { kind: 'record', recordId: source.recordId }
        : { kind: source.kind },
      status: 'pending',
      createdAt: now(),
      approvedBy: null,
      approvedAt: null,
    })
    return { ok: true, entryId: id }
  }

  const approve: AgentMemory['approve'] = (companyId, entryId, approverId) => {
    if (!companyOk(companyId)) return { ok: false, error: 'invalid_company' }
    if (typeof approverId === 'string' && approverId.trim().startsWith('agent:')) {
      return { ok: false, error: 'human_only' }
    }
    if (!isNonEmptyString(approverId)) return { ok: false, error: 'invalid_approver' }

    const entry = entries.get(entryId)
    if (!entry || entry.companyId !== companyId) return { ok: false, error: 'not_found' }
    if (entry.status !== 'pending') return { ok: false, error: 'not_pending' }

    entry.status = 'approved'
    entry.approvedBy = approverId
    entry.approvedAt = now()
    return { ok: true, entry: copyEntry(entry) }
  }

  const recall: AgentMemory['recall'] = (companyId, agentId) => {
    if (!companyOk(companyId)) return { ok: false, error: 'invalid_company' }
    if (!isNonEmptyString(agentId)) return { ok: false, error: 'invalid_agent' }

    const at = now()
    const found: MemoryEntry[] = []
    for (const entry of entries.values()) {
      if (entry.companyId !== companyId) continue
      if (entry.agentId !== agentId) continue
      if (entry.status !== 'approved') continue
      if (isExpired(entry, at)) continue
      found.push(copyEntry(entry))
    }
    return { ok: true, entries: found }
  }

  const forget: AgentMemory['forget'] = (companyId, entryId) => {
    if (!companyOk(companyId)) return { ok: false, error: 'invalid_company' }

    const entry = entries.get(entryId)
    if (!entry || entry.companyId !== companyId) return { ok: false, error: 'not_found' }

    entries.delete(entryId)
    return { ok: true }
  }

  return { propose, approve, recall, forget }
}
