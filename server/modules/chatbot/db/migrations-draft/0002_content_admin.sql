-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Tables: chatbot_canned_responses, chatbot_knowledge_base_articles, chatbot_knowledge_base_article_links.
-- Source of truth: server/modules/chatbot/db/content.ts. Every table carries company_id. Every unique key includes company_id.
-- The link table references articles and chatbots through composite keys on (company_id, id).

CREATE TABLE IF NOT EXISTS chatbot_canned_responses (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  user_id varchar(191),
  title varchar(255) NOT NULL,
  content text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_canned_responses_company_id_uidx ON chatbot_canned_responses (company_id, id);
CREATE INDEX IF NOT EXISTS chatbot_canned_responses_company_title_idx ON chatbot_canned_responses (company_id, title);

CREATE TABLE IF NOT EXISTS chatbot_knowledge_base_articles (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  user_id varchar(191),
  title varchar(255) NOT NULL,
  description text NOT NULL,
  content text,
  is_featured boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_kb_articles_company_id_uidx ON chatbot_knowledge_base_articles (company_id, id);
CREATE INDEX IF NOT EXISTS chatbot_kb_articles_company_featured_idx ON chatbot_knowledge_base_articles (company_id, is_featured);

CREATE TABLE IF NOT EXISTS chatbot_knowledge_base_article_links (
  company_id uuid NOT NULL,
  article_id varchar NOT NULL,
  chatbot_id varchar NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_kb_article_links_article_fk FOREIGN KEY (company_id, article_id)
    REFERENCES chatbot_knowledge_base_articles (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chatbot_kb_article_links_chatbot_fk FOREIGN KEY (company_id, chatbot_id)
    REFERENCES chatbots (company_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_kb_article_links_uidx ON chatbot_knowledge_base_article_links (company_id, article_id, chatbot_id);
CREATE INDEX IF NOT EXISTS chatbot_kb_article_links_company_chatbot_idx ON chatbot_knowledge_base_article_links (company_id, chatbot_id);
