# B4 sip_calls: column-by-column diff

Sources: `shared/schema.ts` lines 2991-3029 (`sipCalls`) and `migrations/0000_damp_spectrum.sql` lines 1075-1093. Later migrations were searched for `sip_calls` (only 0001 touches it: agent_id FK). Name-level comparison was done with a parser script. Type and nullability rows were read by eye.

## Count
- The brief says 36 columns. The schema has **29 column definitions** (verified by script). 29 columns plus **7 indexes** = 36. The 36 most likely counts indexes.
- Migrations: 19 columns. `migrations/meta/0000_snapshot.json` also has 19, so the snapshot is stale.

## Column diff

| Schema column | 0000 SQL | Status | Verified how |
|---|---|---|---|
| id | id | match | name |
| user_id | user_id | match (NOT NULL both) | name |
| agent_id | agent_id | match (FK ON DELETE SET NULL via 0001) | name, 0001 |
| campaign_id | campaign_id | match | name |
| contact_id | contact_id | match | name |
| sip_trunk_id | - | **MISSING** (FK to sip_trunks) | name |
| sip_phone_number_id | sip_phone_number_id | drift: SQL NOT NULL, FK no action; schema nullable, FK SET NULL | read |
| engine | engine | type drift: text vs varchar(50) | read |
| external_call_id | external_call_id | type drift: text vs varchar(255) | read |
| openai_call_id | - | **MISSING** | name |
| elevenlabs_conversation_id | - | **MISSING** | name |
| from_number | from_number | type drift: text vs varchar(50) | read |
| to_number | to_number | type drift: text vs varchar(50) | read |
| direction | direction | type drift: text vs varchar(20) | read |
| status | status | type drift: text vs varchar(50) | read |
| duration_seconds | duration_seconds | default drift: none vs 0 | read |
| credits_used | - | **MISSING** | name |
| recording_url | - | **MISSING** | name |
| transcript | (transcript_json) | **MISSING by name** (SQL has transcript_json) | name |
| ai_summary | - | **MISSING** | name |
| sentiment | - | **MISSING** | name |
| classification | - | **MISSING** | name |
| sip_headers | - | **MISSING** | name |
| metadata | (conversation_data) | **MISSING by name** (SQL has conversation_data) | name |
| started_at | started_at | match | name |
| answered_at | - | **MISSING** | name |
| ended_at | ended_at | match | name |
| created_at | created_at | nullability drift: SQL NOT NULL, schema nullable | read |
| updated_at | updated_at | nullability drift: SQL NOT NULL, schema nullable | read |

SQL columns with no schema name: `transcript_json`, `conversation_data`. Do not drop them; they may hold live data.

Missing by name: 12 (10 absent plus 2 renamed). This matches the "about 12" in the brief.

Indexes: schema defines 7 (user_id, campaign_id, contact_id, status, created_at, external_call_id, elevenlabs_conversation_id). No `CREATE INDEX` on sip_calls exists in any migration (grep).

Comment in schema.ts line 2990 says the names match "001_sip_tables.sql". No such file exists in the repo.

## Not verified
- Live database state. Nothing was queried.
- Whether `transcript_json` and `conversation_data` hold the same data as `transcript` and `metadata`.
- Whether any code path writes or reads `transcript_json` or `conversation_data`. Not searched.
- Whether 0000 is the only source for these tables (other SQL files outside migrations/ were not searched).
