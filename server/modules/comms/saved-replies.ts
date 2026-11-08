// Company-scoped saved replies for inbox agents. Pure in-memory store: no database, no network.
// Every read and write is keyed by companyId, so one company can never see or change another's replies.

import { randomUUID } from 'node:crypto';

export const SAVED_REPLY_CHANNELS = [
  'email',
  'sms',
  'whatsapp',
  'telegram',
  'messenger',
  'instagram',
  'phone',
  'any',
] as const;

export type SavedReplyChannel = (typeof SAVED_REPLY_CHANNELS)[number];

export const SAVED_REPLY_TITLE_MAX = 80;
export const SAVED_REPLY_BODY_MAX = 1600;

export interface SavedReply {
  id: string;
  companyId: string;
  title: string;
  body: string;
  channel: SavedReplyChannel;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SavedReplyInput {
  title: string;
  body: string;
  channel: SavedReplyChannel;
  variables?: string[];
}

export interface SavedReplyPatch {
  title?: string;
  body?: string;
  channel?: SavedReplyChannel;
  variables?: string[];
}

export type SavedReplyReason = 'invalid_input' | 'invalid_company' | 'not_found';

export type SavedReplyResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: SavedReplyReason; message: string };

export interface SavedReplyStore {
  create(companyId: string, input: SavedReplyInput): SavedReplyResult<{ reply: SavedReply }>;
  list(companyId: string, filter?: { channel?: SavedReplyChannel }): SavedReply[];
  update(companyId: string, id: string, patch: SavedReplyPatch): SavedReplyResult<{ reply: SavedReply }>;
  remove(companyId: string, id: string): SavedReplyResult<{}>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

export function isValidCompanyId(companyId: unknown): companyId is string {
  return typeof companyId === 'string' && UUID_RE.test(companyId);
}

function fail(reason: SavedReplyReason, message: string): { ok: false; reason: SavedReplyReason; message: string } {
  return { ok: false, reason, message };
}

function isChannel(value: unknown): value is SavedReplyChannel {
  return typeof value === 'string' && (SAVED_REPLY_CHANNELS as readonly string[]).includes(value);
}

type Validated = { ok: true; value: { title: string; body: string; channel: SavedReplyChannel; variables: string[] } } | { ok: false; reason: 'invalid_input'; message: string };

/**
 * Validates a complete reply (create input, or update input merged over the stored reply).
 * Every `{{name}}` in the body must name an entry in `variables`; any stray `{{` is refused.
 */
function validateReply(input: {
  title: unknown;
  body: unknown;
  channel: unknown;
  variables: unknown;
}): Validated {
  const { title, body, channel, variables } = input;

  if (typeof title !== 'string') return fail('invalid_input', 'title must be a string');
  const trimmedTitle = title.trim();
  if (trimmedTitle.length < 1 || trimmedTitle.length > SAVED_REPLY_TITLE_MAX) {
    return fail('invalid_input', `title must be 1-${SAVED_REPLY_TITLE_MAX} characters`);
  }

  if (typeof body !== 'string') return fail('invalid_input', 'body must be a string');
  const trimmedBody = body.trim();
  if (trimmedBody.length < 1 || trimmedBody.length > SAVED_REPLY_BODY_MAX) {
    return fail('invalid_input', `body must be 1-${SAVED_REPLY_BODY_MAX} characters`);
  }

  if (!isChannel(channel)) {
    return fail('invalid_input', `channel must be one of ${SAVED_REPLY_CHANNELS.join(', ')}`);
  }

  let declared: string[] = [];
  if (variables !== undefined) {
    if (!Array.isArray(variables) || !variables.every((v) => typeof v === 'string')) {
      return fail('invalid_input', 'variables must be an array of strings');
    }
    declared = variables.map((v) => v.trim());
  }

  const names = [...trimmedBody.matchAll(PLACEHOLDER_RE)].map((m) => m[1].trim());
  const openCount = trimmedBody.split('{{').length - 1;
  if (openCount !== names.length) {
    return fail('invalid_input', 'body contains a {{ placeholder that is not closed with }}');
  }
  const undeclared = names.find((name) => !declared.includes(name));
  if (undeclared !== undefined) {
    return fail('invalid_input', `body contains undeclared placeholder {{${undeclared}}}; list it in variables`);
  }

  return {
    ok: true,
    value: { title: trimmedTitle, body: trimmedBody, channel, variables: [...new Set(declared)] },
  };
}

export function createSavedReplyStore(): SavedReplyStore {
  const replies = new Map<string, SavedReply>();

  const copy = (reply: SavedReply): SavedReply => ({ ...reply, variables: [...reply.variables] });

  function ownedReply(companyId: string, id: string): SavedReply | null {
    const reply = replies.get(id);
    return reply && reply.companyId === companyId ? reply : null;
  }

  return {
    create(companyId, input) {
      if (!isValidCompanyId(companyId)) return fail('invalid_company', 'companyId must be a UUID');
      if (input === null || typeof input !== 'object') return fail('invalid_input', 'input must be an object');

      const checked = validateReply({
        title: input.title,
        body: input.body,
        channel: input.channel,
        variables: input.variables,
      });
      if (!checked.ok) return checked;

      const now = new Date().toISOString();
      const reply: SavedReply = {
        id: randomUUID(),
        companyId,
        ...checked.value,
        createdAt: now,
        updatedAt: now,
      };
      replies.set(reply.id, reply);
      return { ok: true, reply: copy(reply) };
    },

    list(companyId, filter = {}) {
      if (!isValidCompanyId(companyId)) return [];
      const wanted = filter.channel;
      return [...replies.values()]
        .filter((r) => r.companyId === companyId)
        .filter((r) => wanted === undefined || r.channel === wanted || r.channel === 'any')
        .map(copy);
    },

    update(companyId, id, patch) {
      if (!isValidCompanyId(companyId)) return fail('invalid_company', 'companyId must be a UUID');
      const existing = ownedReply(companyId, id);
      if (!existing) return fail('not_found', 'saved reply not found');
      if (patch === null || typeof patch !== 'object') return fail('invalid_input', 'patch must be an object');

      const checked = validateReply({
        title: patch.title ?? existing.title,
        body: patch.body ?? existing.body,
        channel: patch.channel ?? existing.channel,
        variables: patch.variables ?? existing.variables,
      });
      if (!checked.ok) return checked;

      Object.assign(existing, checked.value, { updatedAt: new Date().toISOString() });
      return { ok: true, reply: copy(existing) };
    },

    remove(companyId, id) {
      if (!isValidCompanyId(companyId)) return fail('invalid_company', 'companyId must be a UUID');
      if (!ownedReply(companyId, id)) return fail('not_found', 'saved reply not found');
      replies.delete(id);
      return { ok: true };
    },
  };
}
