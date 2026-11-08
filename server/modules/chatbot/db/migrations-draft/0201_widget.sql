-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
-- Number 0201 is a placeholder. The owner renumbers it when promoting.
--
-- Tables: widget_chatbot_configs, widget_embed_keys (db/widget.ts).
-- Constraints:
--   widget_chatbot_configs_company_public_uidx  unique (company_id, public_id)
--   widget_chatbot_configs_public_id_idx        index (public_id), lookup by the embed id
--   widget_chatbot_configs_company_idx          index (company_id)
--   widget_chatbot_configs_position_chk         launcher_position in ('bottom-left', 'bottom-right')
--   widget_embed_keys_company_key_uidx          unique (company_id, key_id)
--   widget_embed_keys_company_idx               index (company_id)

CREATE TABLE IF NOT EXISTS widget_chatbot_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  chatbot_id uuid NOT NULL,
  public_id uuid NOT NULL,
  title varchar(200) NOT NULL,
  welcome_message text NOT NULL DEFAULT '',
  launcher_text varchar(120),
  primary_color varchar(7) NOT NULL DEFAULT '#763ed1',
  launcher_position varchar(16) NOT NULL DEFAULT 'bottom-right',
  language varchar(16) NOT NULL DEFAULT 'en',
  voice_enabled boolean NOT NULL DEFAULT false,
  generative_ui_enabled boolean NOT NULL DEFAULT false,
  allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT widget_chatbot_configs_position_chk CHECK (launcher_position IN ('bottom-left', 'bottom-right'))
);

CREATE UNIQUE INDEX IF NOT EXISTS widget_chatbot_configs_company_public_uidx ON widget_chatbot_configs (company_id, public_id);
CREATE INDEX IF NOT EXISTS widget_chatbot_configs_public_id_idx ON widget_chatbot_configs (public_id);
CREATE INDEX IF NOT EXISTS widget_chatbot_configs_company_idx ON widget_chatbot_configs (company_id);

CREATE TABLE IF NOT EXISTS widget_embed_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  key_id varchar(64) NOT NULL,
  sealed jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS widget_embed_keys_company_key_uidx ON widget_embed_keys (company_id, key_id);
CREATE INDEX IF NOT EXISTS widget_embed_keys_company_idx ON widget_embed_keys (company_id);
