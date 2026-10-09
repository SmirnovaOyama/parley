import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env.ts";
import { findProvider, OFF_BY_DEFAULT } from "./providers/catalog.ts";

mkdirSync(dirname(env.databasePath), { recursive: true });

export const db = new DatabaseSync(env.databasePath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
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
);

CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  api_key_id          INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  monthly_token_limit INTEGER,
  disabled            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS conversations_user ON conversations(user_id, updated_at);

-- in_context = 0 keeps a row out of what is sent to the model (failed or declined exchanges)
-- while admins can still read it.
CREATE TABLE IF NOT EXISTS messages (
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
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);

-- Usage survives conversation deletes, so quotas and reports stay honest.
CREATE TABLE IF NOT EXISTS usage_events (
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
);
CREATE INDEX IF NOT EXISTS usage_user_time ON usage_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  admin_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Keys that aren't shared with everyone, granted to particular people.
CREATE TABLE IF NOT EXISTS user_keys (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, api_key_id)
);
`);

// Columns added after the first release; existing databases gain them on start-up.
/** Adds a column if it's missing; true when it was just added (so a backfill can run once). */
function addColumn(table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}
// shared = 1: anyone can pick this key's model. 0: only people granted it in user_keys.
addColumn("api_keys", "shared", "INTEGER NOT NULL DEFAULT 1");
// Tried once when this key fails before a reply starts.
addColumn("api_keys", "fallback_key_id", "INTEGER REFERENCES api_keys(id) ON DELETE SET NULL");
// The model (key) a conversation uses; null falls back to the person's default.
addColumn("conversations", "api_key_id", "INTEGER REFERENCES api_keys(id) ON DELETE SET NULL");
// A quiet line under a reply, e.g. that the backup key answered it.
addColumn("messages", "note", "TEXT");

// Conversations are trees, so a message can be edited or a reply regenerated without rewriting
// what came before (the newest Claude models tie their reasoning to an unchanged history).
// parent_id is the message this one follows; head_id is the end of the branch on screen.
if (addColumn("messages", "parent_id", "INTEGER REFERENCES messages(id) ON DELETE CASCADE")) {
  // Chats from before branching were a straight line: each message follows the previous one.
  db.exec(`UPDATE messages SET parent_id = (
    SELECT p.id FROM messages p WHERE p.conversation_id = messages.conversation_id AND p.id < messages.id
    ORDER BY p.id DESC LIMIT 1)`);
}
db.exec("CREATE INDEX IF NOT EXISTS messages_parent ON messages(parent_id)");
// A person's own instructions, added to the system prompt of their new chats.
addColumn("users", "about_me", "TEXT");
addColumn("users", "answer_style", "TEXT");
// The system prompt a chat started with. It never changes for that chat: the newest Claude models
// tie their reasoning to the exact prompt, so rewriting it mid-chat would break later replies.
addColumn("conversations", "system_prompt", "TEXT");
// Each chat's own instructions (JSON {aboutMe, answerStyle}): the current ones, and the ones its
// system prompt was sealed with. A change mid-chat is never written into that prompt; it rides on
// the next message as a system note (messages.instructions), so earlier history stays untouched.
addColumn("conversations", "chat_instructions", "TEXT");
addColumn("conversations", "sealed_instructions", "TEXT");
addColumn("messages", "instructions", "TEXT");
// 1 while the title is the app's own (it may be rewritten as the chat goes on); 0 once renamed.
addColumn("conversations", "title_auto", "INTEGER NOT NULL DEFAULT 1");
// The model's visible thinking (Claude's summary, DeepSeek's reasoning) and how long it took.
addColumn("messages", "thinking", "TEXT");
addColumn("messages", "thinking_ms", "INTEGER");
if (addColumn("conversations", "head_id", "INTEGER")) {
  db.exec("UPDATE conversations SET head_id = (SELECT MAX(id) FROM messages m WHERE m.conversation_id = conversations.id)");
}
// Declined replies, for admins to review: the Claude model that declined before another one
// answered (a refusal with no answer at all is stop_reason 'refusal'), and who reviewed it, when.
if (addColumn("messages", "declined_by", "TEXT")) {
  db.exec(`UPDATE messages SET declined_by = (
      SELECT json_extract(j.value, '$.from.model') FROM json_each(messages.content) j
      WHERE json_extract(j.value, '$.type') = 'fallback' LIMIT 1)
    WHERE role = 'assistant' AND json_valid(content) AND content LIKE '%"type":"fallback"%'`);
}
addColumn("messages", "reviewed_at", "TEXT");
addColumn("messages", "reviewed_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL");

// Claude's web search. A key's switch lets its chats search; whether a chat declares the search
// tool at all is fixed when the chat starts (conversations.web_search_tool), because the newest
// models tie their reasoning to the exact tool list: adding or removing a tool mid-chat would
// invalidate it. A key with search off in such a chat sends the tool with tool_choice "none".
addColumn("api_keys", "web_search", "INTEGER NOT NULL DEFAULT 0");
addColumn("conversations", "web_search_tool", "INTEGER NOT NULL DEFAULT 0");
// On a reply: what it searched for and the sources it cited (JSON {searches, sources}).
addColumn("messages", "web", "TEXT");
// On a user message: sent while its key had search off in a chat that declares the tool. The model
// then gets a note that search isn't available (tool_choice "none" alone left it planning a search
// and ending the turn without an answer). Stored, so replaying the chat stays the same.
addColumn("messages", "search_off", "INTEGER NOT NULL DEFAULT 0");
addColumn("usage_events", "web_searches", "INTEGER NOT NULL DEFAULT 0");

// Email rewards: an address a person proved they own, on a domain the admins reward (a school or
// a company, say). One address serves one account. Codes waiting to be typed in live in
// email_codes, one per person, hashed.
addColumn("users", "bonus_email", "TEXT");
addColumn("users", "bonus_verified_at", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_bonus_email ON users(lower(bonus_email)) WHERE bonus_email IS NOT NULL");
db.exec(`
CREATE TABLE IF NOT EXISTS email_codes (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     TEXT NOT NULL,
  day         TEXT NOT NULL,
  sends_today INTEGER NOT NULL DEFAULT 0
);
`);

// A key unlocks its provider's models: api_keys.models is the JSON list people may pick from (its
// model and effort are what new chats start on). Each chat remembers its own pick.
if (addColumn("api_keys", "models", "TEXT")) {
  // Existing keys open up to every model of their provider but the expensive ones, as new keys do.
  const keys = db.prepare("SELECT id, provider, model FROM api_keys").all() as { id: number; provider: string; model: string }[];
  const set = db.prepare("UPDATE api_keys SET models = ? WHERE id = ?");
  for (const k of keys) {
    const all = (findProvider(k.provider)?.models ?? []).map((m) => m.id).filter((id) => !OFF_BY_DEFAULT.has(id));
    set.run(JSON.stringify([...new Set([...all, k.model])]), k.id);
  }
}
addColumn("conversations", "model", "TEXT");
addColumn("conversations", "effort", "TEXT");

// Claude making files with its code execution tool. Like web search: a key's switch lets its chats
// use it, and whether a chat declares the tool is fixed when the chat starts. The sandbox a chat's
// code ran in is reused for its next messages while it lasts (containers belong to one key's
// account). A user message sent while the key had it off carries code_off, and a note says so.
addColumn("api_keys", "code_execution", "INTEGER NOT NULL DEFAULT 0");
addColumn("conversations", "code_tool", "INTEGER NOT NULL DEFAULT 0");
addColumn("conversations", "container_id", "TEXT");
addColumn("conversations", "container_key_id", "INTEGER");
addColumn("conversations", "container_expires_at", "TEXT");
addColumn("messages", "code_off", "INTEGER NOT NULL DEFAULT 0");
// Files a reply made, copied from the provider so links keep working (the files sit next to the
// database, never in the repository). The id is random and goes in the download link.
db.exec(`
CREATE TABLE IF NOT EXISTS message_files (
  id         TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_files_message ON message_files(message_id);
`);

// Monthly spending limits, in US dollars of estimated cost (usage_events.cost_usd). A person
// follows the site's limit for members ('site'), has their own ('own', monthly_spend_limit), or
// none ('none'). Admins aren't held to the site's limit, only to one set on their own page.
addColumn("users", "spend_limit_mode", "TEXT NOT NULL DEFAULT 'site'");
addColumn("users", "monthly_spend_limit", "REAL");

// Shared links: a read-only copy of one chat, frozen at the message it was shared up to. The id is
// the secret in the link. One link per chat; updating it moves the snapshot, stopping deletes it.
db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  leaf_id         INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
`);

export const nowIso = () => new Date().toISOString();

export function startOfMonthIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export function audit(adminId: number, action: string, target?: string) {
  db.prepare("INSERT INTO audit_log (admin_id, action, target, created_at) VALUES (?, ?, ?, ?)").run(
    adminId,
    action,
    target ?? null,
    nowIso(),
  );
}

/** Who can open a shared chat link: anyone who has it, only people signed in here, or nobody. */
export type SharingMode = "anyone" | "signed-in" | "off";
export const SHARING_MODES: readonly SharingMode[] = ["anyone", "signed-in", "off"];

export type Settings = {
  allowSignup: boolean;
  systemPrompt: string;
  showThinking: boolean;
  sharing: SharingMode;
  /** Email rewards: domains whose addresses earn the bonus (subdomains count too). */
  bonusDomains: string[];
  /** Extra tokens a month on top of a person's limit; null for none. */
  bonusTokens: number | null;
  /** Keys a verified person can pick even when they aren't shared with everyone. */
  bonusKeyIds: number[];
  /** Extra dollars a month on top of a person's spending limit; null for none. */
  bonusSpend: number | null;
  /** What each member may spend a month, in dollars, unless their page says otherwise; null for no limit. */
  spendLimit: number | null;
};

/** A dollar amount saved as text; empty (or anything that isn't an amount) reads as none. */
function dollars(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function jsonList<T>(raw: string | undefined, keep: (v: unknown) => v is T): T[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    return Array.isArray(list) ? list.filter(keep) : [];
  } catch {
    return [];
  }
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Answer clearly and concisely, and use Markdown when it helps.";

export function getSettings(): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    allowSignup: map.get("allowSignup") !== "false",
    systemPrompt: map.get("systemPrompt") ?? DEFAULT_SYSTEM_PROMPT,
    showThinking: map.get("showThinking") !== "false",
    sharing: SHARING_MODES.find((m) => m === map.get("sharing")) ?? "anyone",
    bonusDomains: jsonList(map.get("bonusDomains"), (v): v is string => typeof v === "string"),
    bonusTokens: map.get("bonusTokens") ? Number(map.get("bonusTokens")) || null : null,
    bonusKeyIds: jsonList(map.get("bonusKeyIds"), (v): v is number => Number.isInteger(v)),
    bonusSpend: dollars(map.get("bonusSpend")) || null,
    spendLimit: dollars(map.get("spendLimit")),
  };
}

export function saveSettings(next: Partial<Settings>) {
  const put = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  if (next.allowSignup !== undefined) put.run("allowSignup", String(next.allowSignup));
  if (next.systemPrompt !== undefined) put.run("systemPrompt", next.systemPrompt);
  if (next.showThinking !== undefined) put.run("showThinking", String(next.showThinking));
  if (next.sharing !== undefined) put.run("sharing", next.sharing);
  if (next.bonusDomains !== undefined) put.run("bonusDomains", JSON.stringify(next.bonusDomains));
  if (next.bonusTokens !== undefined) put.run("bonusTokens", next.bonusTokens == null ? "" : String(next.bonusTokens));
  if (next.bonusKeyIds !== undefined) put.run("bonusKeyIds", JSON.stringify(next.bonusKeyIds));
  if (next.bonusSpend !== undefined) put.run("bonusSpend", next.bonusSpend == null ? "" : String(next.bonusSpend));
  if (next.spendLimit !== undefined) put.run("spendLimit", next.spendLimit == null ? "" : String(next.spendLimit));
}
