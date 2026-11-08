-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Knowledge base: sources, chunks and embeddings for the chatbot retriever.
-- Tables: chatbot_knowledge_sources, chatbot_knowledge_chunks, chatbot_knowledge_embeddings.
-- Constraints: chatbot_knowledge_sources_pk, chatbot_knowledge_sources_company_chatbot_kind_uri_uidx,
--   chatbot_knowledge_sources_company_chatbot_fk, chatbot_knowledge_sources_kind_check,
--   chatbot_knowledge_sources_status_check, chatbot_knowledge_chunks_pk,
--   chatbot_knowledge_chunks_company_source_ordinal_uidx, chatbot_knowledge_chunks_company_source_fk (cascade),
--   chatbot_knowledge_chunks_company_chatbot_fk, chatbot_knowledge_chunks_ordinal_check,
--   chatbot_knowledge_embeddings_pk, chatbot_knowledge_embeddings_company_chunk_fk (cascade),
--   chatbot_knowledge_embeddings_dimensions_check.
--
-- Depends on chatbots (company_id, id) from shared/schema.ts, which needs a unique index on that pair
-- (chatbots_company_id_uidx).
-- A NULL uri never collides in the unique index, so text and Q&A sources can repeat, as the PHP allowed.

CREATE TABLE IF NOT EXISTS chatbot_knowledge_sources (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  kind varchar(16) NOT NULL,
  title varchar(255) NOT NULL,
  uri text,
  status varchar(16) NOT NULL DEFAULT 'pending',
  content_hash varchar(64),
  last_indexed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_knowledge_sources_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_knowledge_sources_company_chatbot_fk
    FOREIGN KEY (company_id, chatbot_id) REFERENCES chatbots (company_id, id),
  CONSTRAINT chatbot_knowledge_sources_kind_check
    CHECK (kind IN ('url', 'file', 'text', 'product_feed', 'faq')),
  CONSTRAINT chatbot_knowledge_sources_status_check
    CHECK (status IN ('pending', 'indexing', 'ready', 'failed', 'disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_knowledge_sources_company_chatbot_kind_uri_uidx
  ON chatbot_knowledge_sources (company_id, chatbot_id, kind, uri);
CREATE INDEX IF NOT EXISTS chatbot_knowledge_sources_company_chatbot_status_idx
  ON chatbot_knowledge_sources (company_id, chatbot_id, status);

CREATE TABLE IF NOT EXISTS chatbot_knowledge_chunks (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  source_id varchar(191) NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  ordinal integer NOT NULL,
  text text NOT NULL,
  token_count integer NOT NULL,
  content_hash varchar(64) NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_knowledge_chunks_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_knowledge_chunks_company_source_fk
    FOREIGN KEY (company_id, source_id) REFERENCES chatbot_knowledge_sources (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chatbot_knowledge_chunks_company_chatbot_fk
    FOREIGN KEY (company_id, chatbot_id) REFERENCES chatbots (company_id, id),
  CONSTRAINT chatbot_knowledge_chunks_ordinal_check CHECK (ordinal >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_knowledge_chunks_company_source_ordinal_uidx
  ON chatbot_knowledge_chunks (company_id, source_id, ordinal);
CREATE INDEX IF NOT EXISTS chatbot_knowledge_chunks_company_chatbot_idx
  ON chatbot_knowledge_chunks (company_id, chatbot_id);

CREATE TABLE IF NOT EXISTS chatbot_knowledge_embeddings (
  company_id uuid NOT NULL,
  chunk_id varchar(191) NOT NULL,
  provider varchar(16) NOT NULL,
  model varchar(100) NOT NULL,
  dimensions integer NOT NULL,
  vector jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_knowledge_embeddings_pk PRIMARY KEY (company_id, chunk_id, provider, model),
  CONSTRAINT chatbot_knowledge_embeddings_company_chunk_fk
    FOREIGN KEY (company_id, chunk_id) REFERENCES chatbot_knowledge_chunks (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chatbot_knowledge_embeddings_dimensions_check CHECK (dimensions > 0)
);

CREATE INDEX IF NOT EXISTS chatbot_knowledge_embeddings_company_model_idx
  ON chatbot_knowledge_embeddings (company_id, provider, model, dimensions);
