// Marketing content lifecycle: a pure state machine. No I/O, no clock, no randomness.
// Every transition returns a new item (or a refusal). The input item is never mutated.
// Flow: draft -> in_review -> approved -> published. Rollback from published creates a new draft.

export type ContentStatus = 'draft' | 'in_review' | 'approved' | 'published';

export type ContentAction = 'created' | 'edited' | 'submitted' | 'approved' | 'published' | 'rolled_back';

export type HistoryEntry = {
  version: number;
  action: ContentAction;
  by: string | null;
  at: string | null;
  restoredFromVersion?: number;
};

export type PublishedVersion = {
  version: number;
  body: string;
  publishedBy: string;
  publishedAt: string | null;
};

export type ContentItem = {
  companyId: string;
  title: string;
  body: string;
  status: ContentStatus;
  version: number;
  submittedBy: string | null;
  approvedBy: string | null;
  publishedVersions: PublishedVersion[];
  history: HistoryEntry[];
};

export type ContentFailureReason =
  | 'invalid_company'
  | 'missing_field'
  | 'invalid_transition'
  | 'human_only'
  | 'self_approval'
  | 'not_editable'
  | 'no_previous_version';

export type ContentResult = { ok: true; item: ContentItem } | { ok: false; reason: ContentFailureReason };

export type CreateContentInput = {
  companyId: string;
  title: string;
  body: string;
  by?: string | null;
  now?: string | null;
};

export type ContentPatch = { title?: string; body?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

// A human actor is any non-blank id that does not carry the agent: prefix.
// The prefix test ignores surrounding whitespace and case so ' Agent:x' cannot pass as human.
function isHuman(id: unknown): boolean {
  if (isBlank(id)) return false;
  return !(id as string).trim().toLowerCase().startsWith('agent:');
}

// Returns a new item with the patch applied and one history entry appended.
// Arrays are copied so the input item's arrays are never shared with the result.
function advance(item: ContentItem, patch: Partial<ContentItem>, entry: HistoryEntry): ContentItem {
  return {
    ...item,
    ...patch,
    publishedVersions: patch.publishedVersions ?? [...item.publishedVersions],
    history: [...item.history, entry],
  };
}

export function createContentItem(input: CreateContentInput): ContentResult {
  if (typeof input.companyId !== 'string' || !UUID_RE.test(input.companyId)) {
    return { ok: false, reason: 'invalid_company' };
  }
  if (isBlank(input.title) || typeof input.body !== 'string') {
    return { ok: false, reason: 'missing_field' };
  }
  const by = input.by ?? null;
  const at = input.now ?? null;
  const item: ContentItem = {
    companyId: input.companyId,
    title: input.title,
    body: input.body,
    status: 'draft',
    version: 1,
    submittedBy: null,
    approvedBy: null,
    publishedVersions: [],
    history: [{ version: 1, action: 'created', by, at }],
  };
  return { ok: true, item };
}

export function submitForReview(item: ContentItem, by: string, now: string): ContentResult {
  if (item.status !== 'draft') return { ok: false, reason: 'invalid_transition' };
  if (isBlank(by)) return { ok: false, reason: 'missing_field' };
  return {
    ok: true,
    item: advance(
      item,
      { status: 'in_review', submittedBy: by },
      { version: item.version, action: 'submitted', by, at: now ?? null },
    ),
  };
}

export function approve(item: ContentItem, approverId: string, now: string): ContentResult {
  if (!isHuman(approverId)) return { ok: false, reason: 'human_only' };
  if (item.status !== 'in_review') return { ok: false, reason: 'invalid_transition' };
  if (approverId === item.submittedBy) return { ok: false, reason: 'self_approval' };
  return {
    ok: true,
    item: advance(
      item,
      { status: 'approved', approvedBy: approverId },
      { version: item.version, action: 'approved', by: approverId, at: now ?? null },
    ),
  };
}

export function publish(item: ContentItem, by: string, now: string): ContentResult {
  if (!isHuman(by)) return { ok: false, reason: 'human_only' };
  if (item.status !== 'approved') return { ok: false, reason: 'invalid_transition' };
  const publishedVersions = [
    ...item.publishedVersions,
    { version: item.version, body: item.body, publishedBy: by, publishedAt: now ?? null },
  ];
  return {
    ok: true,
    item: advance(
      item,
      { status: 'published', publishedVersions },
      { version: item.version, action: 'published', by, at: now ?? null },
    ),
  };
}

// Restores the body of the previous published version into a new draft and records the restore
// in history. publishedVersions is never trimmed, so every publish stays in the record.
// The current published version is the last record; the previous one is the record before it.
// Two records are enough. Zero or one earlier record means there is nothing to restore.
// The new draft must go through review and publish again before it is live.
export function rollback(item: ContentItem, by: string, now: string): ContentResult {
  if (!isHuman(by)) return { ok: false, reason: 'human_only' };
  if (item.status !== 'published') return { ok: false, reason: 'invalid_transition' };
  const previous = item.publishedVersions[item.publishedVersions.length - 2];
  if (previous === undefined) return { ok: false, reason: 'no_previous_version' };
  const version = item.version + 1;
  return {
    ok: true,
    item: advance(
      item,
      { status: 'draft', version, body: previous.body, submittedBy: null, approvedBy: null },
      {
        version,
        action: 'rolled_back',
        by,
        at: now ?? null,
        restoredFromVersion: previous.version,
      },
    ),
  };
}

// Only title and body can be patched. Other keys are ignored.
export function edit(item: ContentItem, by: string, now: string, patch: ContentPatch): ContentResult {
  if (item.status !== 'draft') return { ok: false, reason: 'not_editable' };
  if (isBlank(by)) return { ok: false, reason: 'missing_field' };
  if (patch === null || typeof patch !== 'object') return { ok: false, reason: 'missing_field' };
  const changes: Partial<ContentItem> = {};
  if ('title' in patch) {
    if (isBlank(patch.title)) return { ok: false, reason: 'missing_field' };
    changes.title = patch.title;
  }
  if ('body' in patch) {
    if (typeof patch.body !== 'string') return { ok: false, reason: 'missing_field' };
    changes.body = patch.body;
  }
  return {
    ok: true,
    item: advance(item, changes, { version: item.version, action: 'edited', by, at: now ?? null }),
  };
}
