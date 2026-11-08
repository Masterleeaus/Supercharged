import { assertCanonicalCompanyId, rejectLegacyTenantAuthority } from '../../packages/titan-platform/src/ported/titan-runtime/boundary.js';
import { canonicalSurface, createInteractionContext } from '../../packages/titan-platform/src/ported/titan-runtime/interaction-engine/contracts.js';
import { createConversationState } from '../../packages/titan-platform/src/ported/titan-runtime/interaction-engine/state.js';

export const CONVERSATION_STATE_RUNTIME_SCHEMA = 'titan.interaction.conversation-state-runtime.v1';
export const CONVERSATION_STATE_MODULE_ID = 'titan.interaction';
export const CONVERSATION_STATE_COLLECTIONS = Object.freeze({
  conversations: 'conversation-states',
  sessions: 'interaction-session-states',
  contexts: 'interaction-context-states',
});

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}-object-required`);
  rejectLegacyTenantAuthority(value, label);
  return value;
}

function nonEmpty(value, label) {
  const out = String(value ?? '').trim();
  if (!out) throw new TypeError(`${label}-required`);
  return out;
}

function contextCompany(contextInput) {
  const value = requireObject(contextInput, 'conversation-state-context');
  return assertCanonicalCompanyId(value.company_id);
}

function assertPayloadCompany(payload, companyId, label) {
  requireObject(payload, label);
  if (payload.company_id != null && String(payload.company_id).trim() !== companyId) {
    throw new Error(`Cross-company ${label} rejected`);
  }
}

function freezeArray(value) {
  return Object.freeze(Array.isArray(value) ? [...value] : []);
}

function createSessionState(companyId, input, now) {
  const value = requireObject(input, 'interaction-session-state');
  assertPayloadCompany(value, companyId, 'interaction-session-state');
  return Object.freeze({
    schema: 'titan.interaction.session-state.v1',
    company_id: companyId,
    surface: canonicalSurface(value.surface ?? 'zero'),
    session_id: nonEmpty(value.session_id, 'session-id'),
    conversation_id: nonEmpty(value.conversation_id, 'conversation-id'),
    journey_id: value.journey_id == null ? null : nonEmpty(value.journey_id, 'journey-id'),
    wizard_id: value.wizard_id == null ? null : nonEmpty(value.wizard_id, 'wizard-id'),
    status: value.status ?? 'active',
    current_goal: value.current_goal ?? null,
    unresolved_questions: freezeArray(value.unresolved_questions),
    context_refs: freezeArray(value.context_refs),
    created_at: Number(value.created_at ?? now),
    updated_at: Number(value.updated_at ?? now),
    authority_neutral: true,
    authority_granted: false,
    execution_authority: false,
  });
}

function createContextState(companyId, input, now) {
  const value = requireObject(input, 'interaction-context-state');
  assertPayloadCompany(value, companyId, 'interaction-context-state');
  const canonical = createInteractionContext({ ...value, company_id: companyId });
  return Object.freeze({
    schema: 'titan.interaction.context-state.v1',
    ...canonical,
    context_id: nonEmpty(value.context_id, 'context-id'),
    session_id: nonEmpty(value.session_id, 'session-id'),
    conversation_id: nonEmpty(value.conversation_id, 'conversation-id'),
    metadata: value.metadata == null ? null : structuredClone(value.metadata),
    created_at: Number(value.created_at ?? now),
    updated_at: Number(value.updated_at ?? now),
    authority_neutral: true,
    authority_granted: false,
    execution_authority: false,
  });
}

function recordInput(collection, recordId, state) {
  return {
    module_id: CONVERSATION_STATE_MODULE_ID,
    collection,
    record_id: recordId,
    data: state,
    provenance: {
      schema: CONVERSATION_STATE_RUNTIME_SCHEMA,
      source: 'interaction-engine',
      durable_state_only: true,
      authority_neutral: true,
    },
  };
}

function locator(collection, recordId) {
  return { module_id: CONVERSATION_STATE_MODULE_ID, collection, record_id: nonEmpty(recordId, 'record-id') };
}

function unwrap(record) {
  return record?.data ?? null;
}

export function createConversationStateRuntime({ database, clock = () => Date.now() } = {}) {
  if (!database || typeof database.putRecord !== 'function' || typeof database.getRecord !== 'function') {
    throw new TypeError('conversation-state-database-required');
  }

  const saveConversation = async (contextInput, input) => {
    const companyId = contextCompany(contextInput);
    assertPayloadCompany(input, companyId, 'conversation-state');
    const now = Number(clock());
    const state = createConversationState({ ...input, company_id: companyId, updated_at: input.updated_at ?? now });
    return database.putRecord(contextInput, recordInput(CONVERSATION_STATE_COLLECTIONS.conversations, state.conversation_id, state));
  };

  const saveSession = async (contextInput, input) => {
    const companyId = contextCompany(contextInput);
    const state = createSessionState(companyId, input, Number(clock()));
    return database.putRecord(contextInput, recordInput(CONVERSATION_STATE_COLLECTIONS.sessions, state.session_id, state));
  };

  const saveContext = async (contextInput, input) => {
    const companyId = contextCompany(contextInput);
    const state = createContextState(companyId, input, Number(clock()));
    return database.putRecord(contextInput, recordInput(CONVERSATION_STATE_COLLECTIONS.contexts, state.context_id, state));
  };

  const loadConversation = async (contextInput, conversationId) => unwrap(await database.getRecord(contextInput, locator(CONVERSATION_STATE_COLLECTIONS.conversations, conversationId)));
  const loadSession = async (contextInput, sessionId) => unwrap(await database.getRecord(contextInput, locator(CONVERSATION_STATE_COLLECTIONS.sessions, sessionId)));
  const loadContext = async (contextInput, contextId) => unwrap(await database.getRecord(contextInput, locator(CONVERSATION_STATE_COLLECTIONS.contexts, contextId)));

  const loadBundle = async (contextInput, ids = {}) => {
    requireObject(ids, 'conversation-state-bundle-locator');
    const [conversation, session, context] = await Promise.all([
      ids.conversation_id ? loadConversation(contextInput, ids.conversation_id) : null,
      ids.session_id ? loadSession(contextInput, ids.session_id) : null,
      ids.context_id ? loadContext(contextInput, ids.context_id) : null,
    ]);
    const companyId = contextCompany(contextInput);
    for (const value of [conversation, session, context]) {
      if (value && value.company_id !== companyId) throw new Error('Cross-company restored conversation state rejected');
    }
    return Object.freeze({
      schema: CONVERSATION_STATE_RUNTIME_SCHEMA,
      company_id: companyId,
      conversation,
      session,
      context,
      restart_safe: true,
      authority_neutral: true,
      authority_granted: false,
      execution_authority: false,
    });
  };

  return Object.freeze({
    schema: CONVERSATION_STATE_RUNTIME_SCHEMA,
    authority_neutral: true,
    execution_authority: false,
    saveConversation,
    loadConversation,
    saveSession,
    loadSession,
    saveContext,
    loadContext,
    loadBundle,
  });
}
