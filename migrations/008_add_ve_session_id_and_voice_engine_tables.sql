-- ============================================================
-- Migration 008: Custom Voice Engine (ve_*) base tables and indexes.
--
-- Source of the column list: the ve_* DDL in scripts/apply-plugin-sql-direct.ts, the only
-- committed definition of these tables. shared/schema.ts has no Drizzle table for them.
--
-- Creates 11 tables, in dependency order (a table is created after the tables it references):
--   ve_freeswitch_nodes, ve_provider_configs, ve_voice_agents, ve_sessions,
--   ve_call_recordings, ve_customer_memory, ve_customer_facts, ve_conversation_memory,
--   ve_llm_cache, ve_usage_tracking, ve_sip_gateways.
--
-- Columns added after the base shape (ve_voice_agents 002-004 and the leads/ve_sessions
-- columns) are in migration 009, not here.
--
-- Idempotent (CREATE ... IF NOT EXISTS, CREATE INDEX IF NOT EXISTS). No DROP, no ALTER.
-- The runner wraps this file in BEGIN/COMMIT, so the file has no transaction statements.
-- ============================================================

-- ─── 001: FreeSWITCH Nodes ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ve_freeswitch_nodes (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL,
    esl_host TEXT NOT NULL DEFAULT '127.0.0.1',
    esl_port INTEGER NOT NULL DEFAULT 8021,
    esl_password TEXT NOT NULL DEFAULT 'ClueCon',
    sip_host TEXT NOT NULL,
    sip_port INTEGER NOT NULL DEFAULT 5060,
    ws_port INTEGER NOT NULL DEFAULT 8089,
    status TEXT NOT NULL DEFAULT 'offline', 
    active_calls INTEGER NOT NULL DEFAULT 0,
    max_calls INTEGER NOT NULL DEFAULT 100,
    last_health_check TIMESTAMP,
    metadata JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── 001: Tenant Provider Configurations ──────────────────────────
CREATE TABLE IF NOT EXISTS ve_provider_configs (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id VARCHAR NOT NULL,
    stt_provider TEXT NOT NULL DEFAULT 'deepgram', 
    stt_api_key TEXT,
    stt_config JSONB,
    llm_provider TEXT NOT NULL DEFAULT 'openrouter',
    llm_api_key TEXT,
    llm_model TEXT NOT NULL DEFAULT 'openai/gpt-4o-mini',
    llm_config JSONB,
    tts_provider TEXT NOT NULL DEFAULT 'deepgram', 
    tts_api_key TEXT,
    tts_voice TEXT NOT NULL DEFAULT 'aura-asteria-en',
    tts_config JSONB,
    max_concurrent_calls INTEGER NOT NULL DEFAULT 10,
    recording_enabled BOOLEAN NOT NULL DEFAULT true,
    recording_storage TEXT NOT NULL DEFAULT 'local', 
    recording_retention_days INTEGER NOT NULL DEFAULT 30,
    recording_storage_config JSONB, 
    memory_enabled BOOLEAN NOT NULL DEFAULT true,
    cache_enabled BOOLEAN NOT NULL DEFAULT true,
    cache_ttl_seconds INTEGER NOT NULL DEFAULT 3600,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_ve_provider_configs_user ON ve_provider_configs(user_id);

-- ─── 001: Voice Agents ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ve_voice_agents (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id VARCHAR NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,
    first_message TEXT DEFAULT 'Hello! How can I help you today?',
    language TEXT NOT NULL DEFAULT 'en',
    llm_model TEXT NOT NULL DEFAULT 'openai/gpt-4o-mini',
    temperature DOUBLE PRECISION DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 500,
    tts_voice TEXT NOT NULL DEFAULT 'aura-asteria-en',
    tts_provider TEXT NOT NULL DEFAULT 'deepgram',
    stt_provider TEXT NOT NULL DEFAULT 'deepgram',
    interruptible BOOLEAN NOT NULL DEFAULT true,
    silence_timeout_ms INTEGER NOT NULL DEFAULT 5000,
    max_duration_seconds INTEGER NOT NULL DEFAULT 600,
    end_call_on_silence BOOLEAN NOT NULL DEFAULT false,
    business_rules JSONB DEFAULT '[]'::jsonb,
    knowledge_base_ids TEXT[],
    enabled_tools TEXT[],
    enable_memory BOOLEAN NOT NULL DEFAULT true,
    memory_retention_days INTEGER NOT NULL DEFAULT 90,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ve_voice_agents_user ON ve_voice_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_ve_voice_agents_active ON ve_voice_agents(user_id, is_active);

-- ─── 001: Voice Sessions ───────────────────────────────
CREATE TABLE IF NOT EXISTS ve_sessions (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id VARCHAR NOT NULL,
    agent_id VARCHAR REFERENCES ve_voice_agents(id) ON DELETE SET NULL,
    call_id VARCHAR, 
    freeswitch_node_id VARCHAR REFERENCES ve_freeswitch_nodes(id) ON DELETE SET NULL,
    channel_uuid TEXT,
    from_number TEXT,
    to_number TEXT,
    direction TEXT NOT NULL DEFAULT 'inbound', 
    status TEXT NOT NULL DEFAULT 'initializing',
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMP,
    ended_at TIMESTAMP,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    end_reason TEXT, 
    stt_provider TEXT NOT NULL DEFAULT 'deepgram',
    llm_provider TEXT NOT NULL DEFAULT 'openrouter',
    tts_provider TEXT NOT NULL DEFAULT 'deepgram',
    llm_model TEXT NOT NULL DEFAULT 'openai/gpt-4o-mini',
    stt_duration_ms INTEGER NOT NULL DEFAULT 0,
    llm_prompt_tokens INTEGER NOT NULL DEFAULT 0,
    llm_completion_tokens INTEGER NOT NULL DEFAULT 0,
    tts_duration_ms INTEGER NOT NULL DEFAULT 0,
    tts_characters INTEGER NOT NULL DEFAULT 0,
    transcript JSONB DEFAULT '[]'::jsonb,
    ai_summary TEXT,
    sentiment TEXT, 
    classification TEXT,
    total_cost DECIMAL(10, 6) NOT NULL DEFAULT 0,
    credits_used INTEGER NOT NULL DEFAULT 0,
    metadata JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ve_sessions_user ON ve_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ve_sessions_status ON ve_sessions(status);
CREATE INDEX IF NOT EXISTS idx_ve_sessions_created ON ve_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_ve_sessions_call ON ve_sessions(call_id);
CREATE INDEX IF NOT EXISTS idx_ve_sessions_agent ON ve_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_ve_sessions_direction ON ve_sessions(user_id, direction);

-- ─── 001: Call Recordings ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ve_call_recordings (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    session_id VARCHAR NOT NULL REFERENCES ve_sessions(id) ON DELETE CASCADE,
    user_id VARCHAR NOT NULL,
    call_id VARCHAR,
    storage_backend TEXT NOT NULL DEFAULT 'local', 
    storage_path TEXT NOT NULL,
    storage_url TEXT,
    file_size INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL DEFAULT 'wav', 
    status TEXT NOT NULL DEFAULT 'recording', 
    transcript TEXT,
    metadata JSONB,
    retention_expires_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ve_recordings_session ON ve_call_recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_ve_recordings_user ON ve_call_recordings(user_id);
CREATE INDEX IF NOT EXISTS idx_ve_recordings_status ON ve_call_recordings(status);
CREATE INDEX IF NOT EXISTS idx_ve_recordings_retention ON ve_call_recordings(retention_expires_at);

-- ─── 001: Customer Memory ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ve_customer_memory (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id VARCHAR NOT NULL, 
    phone_number TEXT NOT NULL,
    customer_name TEXT,
    customer_email TEXT,
    customer_company TEXT,
    language TEXT,
    timezone TEXT,
    tags TEXT[],
    custom_fields JSONB,
    total_calls INTEGER NOT NULL DEFAULT 0,
    total_duration_seconds INTEGER NOT NULL DEFAULT 0,
    avg_sentiment DOUBLE PRECISION,
    last_interaction_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_ve_customer_memory_user ON ve_customer_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_ve_customer_memory_phone ON ve_customer_memory(phone_number);
CREATE INDEX IF NOT EXISTS idx_ve_customer_memory_lookup ON ve_customer_memory(user_id, phone_number);

-- ─── 001: Customer Facts ───────────
CREATE TABLE IF NOT EXISTS ve_customer_facts (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    memory_id VARCHAR NOT NULL REFERENCES ve_customer_memory(id) ON DELETE CASCADE,
    fact TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other', 
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    source_session_id VARCHAR REFERENCES ve_sessions(id) ON DELETE SET NULL,
    extracted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ve_customer_facts_memory ON ve_customer_facts(memory_id);
CREATE INDEX IF NOT EXISTS idx_ve_customer_facts_category ON ve_customer_facts(category);

-- ─── 001: Conversation Memory ───────
CREATE TABLE IF NOT EXISTS ve_conversation_memory (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    memory_id VARCHAR NOT NULL REFERENCES ve_customer_memory(id) ON DELETE CASCADE,
    session_id VARCHAR NOT NULL REFERENCES ve_sessions(id) ON DELETE CASCADE,
    call_date TIMESTAMP NOT NULL DEFAULT NOW(),
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    direction TEXT NOT NULL DEFAULT 'inbound',
    summary TEXT NOT NULL,
    outcome TEXT,
    sentiment TEXT, 
    topics TEXT[],
    key_points JSONB, 
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ve_conversation_memory_mem ON ve_conversation_memory(memory_id);
CREATE INDEX IF NOT EXISTS idx_ve_conversation_memory_session ON ve_conversation_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_ve_conversation_memory_date ON ve_conversation_memory(call_date);

-- ─── 001: LLM Response Cache ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS ve_llm_cache (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id VARCHAR NOT NULL,
    cache_key TEXT NOT NULL, 
    prompt_text TEXT NOT NULL,
    response_text TEXT NOT NULL,
    embedding JSONB, 
    model TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 3600,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_ve_llm_cache_user ON ve_llm_cache(user_id);
CREATE INDEX IF NOT EXISTS idx_ve_llm_cache_key ON ve_llm_cache(user_id, cache_key);
CREATE INDEX IF NOT EXISTS idx_ve_llm_cache_expires ON ve_llm_cache(expires_at);

-- ─── 001: Usage Tracking ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ve_usage_tracking (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id VARCHAR NOT NULL,
    session_id VARCHAR NOT NULL REFERENCES ve_sessions(id) ON DELETE CASCADE,
    call_id VARCHAR,
    stt_provider TEXT NOT NULL,
    stt_duration_ms INTEGER NOT NULL DEFAULT 0,
    stt_cost DECIMAL(10, 6) NOT NULL DEFAULT 0,
    llm_provider TEXT NOT NULL,
    llm_model TEXT NOT NULL,
    llm_prompt_tokens INTEGER NOT NULL DEFAULT 0,
    llm_completion_tokens INTEGER NOT NULL DEFAULT 0,
    llm_cost DECIMAL(10, 6) NOT NULL DEFAULT 0,
    tts_provider TEXT NOT NULL,
    tts_characters INTEGER NOT NULL DEFAULT 0,
    tts_duration_ms INTEGER NOT NULL DEFAULT 0,
    tts_cost DECIMAL(10, 6) NOT NULL DEFAULT 0,
    recording_storage_bytes INTEGER NOT NULL DEFAULT 0,
    recording_cost DECIMAL(10, 6) NOT NULL DEFAULT 0,
    total_cost DECIMAL(10, 6) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ve_usage_user ON ve_usage_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_ve_usage_session ON ve_usage_tracking(session_id);
CREATE INDEX IF NOT EXISTS idx_ve_usage_created ON ve_usage_tracking(created_at);
CREATE INDEX IF NOT EXISTS idx_ve_usage_user_date ON ve_usage_tracking(user_id, created_at);

-- ─── 001: SIP Gateways ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ve_sip_gateways (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    proxy TEXT NOT NULL,
    register BOOLEAN NOT NULL DEFAULT false,
    caller_id_in_from BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
