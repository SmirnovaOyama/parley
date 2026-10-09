-- The schema a database has after running the first release (commit 80a4aec), dumped from
-- sqlite_master. Its api_keys table still has the CHECK naming two providers that server/db.ts
-- now rebuilds the table without. Columns the first release added on start-up are on the end of
-- their CREATE TABLE, as SQLite keeps them.

CREATE TABLE api_keys (
  id            INTEGER PRIMARY KEY,
  label         TEXT NOT NULL,
  provider      TEXT NOT NULL CHECK (provider IN ('anthropic', 'deepseek')),
  model         TEXT NOT NULL,
  effort        TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  last4         TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
, shared INTEGER NOT NULL DEFAULT 1, fallback_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL, web_search INTEGER NOT NULL DEFAULT 0, models TEXT, code_execution INTEGER NOT NULL DEFAULT 0);

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  api_key_id          INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  monthly_token_limit INTEGER,
  disabled            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
, about_me TEXT, answer_style TEXT, bonus_email TEXT, bonus_verified_at TEXT, spend_limit_mode TEXT NOT NULL DEFAULT 'site', monthly_spend_limit REAL);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
, api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL, system_prompt TEXT, chat_instructions TEXT, sealed_instructions TEXT, title_auto INTEGER NOT NULL DEFAULT 1, head_id INTEGER, web_search_tool INTEGER NOT NULL DEFAULT 0, model TEXT, effort TEXT, code_tool INTEGER NOT NULL DEFAULT 0, container_id TEXT, container_key_id INTEGER, container_expires_at TEXT);

CREATE INDEX conversations_user ON conversations(user_id, updated_at);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text            TEXT NOT NULL,
  content         TEXT,
  provider        TEXT,
  model           TEXT,
  stop_reason     TEXT,
  error           TEXT,
  in_context      INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
, note TEXT, parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, instructions TEXT, thinking TEXT, thinking_ms INTEGER, declined_by TEXT, reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, web TEXT, search_off INTEGER NOT NULL DEFAULT 0, code_off INTEGER NOT NULL DEFAULT 0);

CREATE INDEX messages_conversation ON messages(conversation_id, id);

CREATE TABLE usage_events (
  id                 INTEGER PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  api_key_id         INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  key_label          TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd           REAL NOT NULL,
  created_at         TEXT NOT NULL
, web_searches INTEGER NOT NULL DEFAULT 0);

CREATE INDEX usage_user_time ON usage_events(user_id, created_at);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  admin_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE user_keys (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, api_key_id)
);

CREATE INDEX messages_parent ON messages(parent_id);

CREATE UNIQUE INDEX users_bonus_email ON users(lower(bonus_email)) WHERE bonus_email IS NOT NULL;

CREATE TABLE email_codes (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     TEXT NOT NULL,
  day         TEXT NOT NULL,
  sends_today INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE message_files (
  id         TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX message_files_message ON message_files(message_id);

CREATE TABLE shares (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  leaf_id         INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
