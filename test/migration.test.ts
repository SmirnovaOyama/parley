// Upgrading a first-release database: server/db.ts rebuilds api_keys without the CHECK that named
// only Claude and DeepSeek, and everything pointing at a key has to come through it.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";

let db: DatabaseSync;
/** Rows as plain objects (node:sqlite gives them no prototype). */
const all = (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
const get = (sql: string) => ({ ...db.prepare(sql).get() });
/** Every column a first-release key has. */
const KEY_ROWS = `SELECT id, label, provider, model, effort, encrypted_key, last4, is_default, created_by, created_at, shared,
  fallback_key_id, web_search, models, code_execution FROM api_keys ORDER BY id`;
let keysBefore: unknown[];

before(async () => {
  // A database as the first release left it, with people, keys, grants and chats in it.
  const old = new DatabaseSync(process.env.DATABASE_PATH!);
  old.exec(readFileSync(new URL("./fixtures/first-release.sql", import.meta.url), "utf8"));
  const at = "2026-09-01T00:00:00.000Z";
  old.exec(`
    INSERT INTO users (id, email, password_hash, role, created_at) VALUES
      (1, 'admin@example.com', 'x', 'admin', '${at}'),
      (2, 'member@example.com', 'x', 'user', '${at}');
    INSERT INTO api_keys (id, label, provider, model, effort, encrypted_key, last4, is_default, created_by, created_at,
        shared, fallback_key_id, web_search, models, code_execution) VALUES
      (1, 'Claude', 'anthropic', 'claude-opus-5-5', 'low', 'v1:a:b:c', '1234', 1, 1, '${at}', 1, NULL, 1, '["claude-opus-5-5"]', 1),
      (2, 'DeepSeek', 'deepseek', 'deepseek-flash', 'off', 'v1:d:e:f', '5678', 0, 1, '${at}', 0, 1, 0, '["deepseek-flash"]', 0);
    UPDATE api_keys SET fallback_key_id = 2 WHERE id = 1;
    UPDATE users SET api_key_id = 2 WHERE id = 2;
    INSERT INTO user_keys (user_id, api_key_id) VALUES (2, 1), (2, 2);
    INSERT INTO conversations (id, user_id, title, created_at, updated_at, api_key_id, container_key_id) VALUES
      ('chat-1', 1, 'Opus chat', '${at}', '${at}', 1, 1),
      ('chat-2', 2, 'DeepSeek chat', '${at}', '${at}', 2, NULL);
    INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES (1, 'chat-1', 'user', 'Hello', '${at}');
    INSERT INTO usage_events (user_id, api_key_id, key_label, provider, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, cost_usd, created_at) VALUES (2, 2, 'DeepSeek', 'deepseek', 'deepseek-flash', 10, 5, 0, 0, 0.001, '${at}');
  `);
  assert.throws(() => old.exec(`INSERT INTO api_keys (label, provider, model, effort, encrypted_key, last4, created_at) VALUES ('x', 'openai', 'gpt', 'low', 'k', '0000', '${at}')`), /CHECK constraint failed/);
  keysBefore = old.prepare(KEY_ROWS).all().map((row) => ({ ...row }));
  old.close();

  ({ db } = await import("../server/db.ts"));
});

test("api_keys loses the CHECK on its provider", () => {
  const { sql } = get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'") as { sql: string };
  assert.doesNotMatch(sql, /CHECK/);
  assert.match(sql, /\bendpoint TEXT\b/);
  assert.doesNotMatch(sql, /api_keys_new/);
  db.prepare(
    "INSERT INTO api_keys (id, label, provider, model, effort, encrypted_key, last4, created_at, endpoint) VALUES (3, 'Ollama', 'custom', 'gpt-oss:20b', 'default', 'k', '0000', ?, ?)",
  ).run(new Date().toISOString(), JSON.stringify({ baseUrl: "http://localhost:11434/v1", models: [{ id: "gpt-oss:20b", input: null, output: null }], images: false }));
  assert.equal((get("SELECT provider FROM api_keys WHERE id = 3") as { provider: string }).provider, "custom");
});

test("every key comes through as it was", () => {
  assert.deepEqual(all(`${KEY_ROWS} LIMIT 2`), keysBefore);
});

test("everything that pointed at a key still does", () => {
  assert.deepEqual(all("SELECT id, api_key_id FROM users ORDER BY id"), [
    { id: 1, api_key_id: null },
    { id: 2, api_key_id: 2 },
  ]);
  assert.deepEqual(all("SELECT user_id, api_key_id FROM user_keys ORDER BY api_key_id"), [
    { user_id: 2, api_key_id: 1 },
    { user_id: 2, api_key_id: 2 },
  ]);
  assert.deepEqual(all("SELECT id, api_key_id FROM conversations ORDER BY id"), [
    { id: "chat-1", api_key_id: 1 },
    { id: "chat-2", api_key_id: 2 },
  ]);
  assert.deepEqual(all("SELECT api_key_id FROM usage_events"), [{ api_key_id: 2 }]);
  assert.deepEqual(all("SELECT id, fallback_key_id FROM api_keys WHERE id < 3 ORDER BY id"), [
    { id: 1, fallback_key_id: 2 },
    { id: 2, fallback_key_id: 1 },
  ]);
  assert.deepEqual(all("PRAGMA foreign_key_check"), []);
});

test("the references still name api_keys, and foreign keys are back on", () => {
  for (const table of ["users", "user_keys", "conversations", "usage_events", "api_keys"]) {
    const targets = (all(`PRAGMA foreign_key_list(${table})`) as { table: string; from: string }[])
      .filter((fk) => fk.from.endsWith("key_id"))
      .map((fk) => fk.table);
    assert.ok(targets.length > 0, `${table} has no key reference`);
    assert.deepEqual(new Set(targets), new Set(["api_keys"]), `${table} points at ${targets}`);
  }
  assert.deepEqual(get("PRAGMA foreign_keys"), { foreign_keys: 1 });
});

test("deleting a key reaches what points at it, through the rebuilt table", () => {
  db.prepare("DELETE FROM api_keys WHERE id = 2").run();
  assert.deepEqual(get("SELECT api_key_id FROM users WHERE id = 2"), { api_key_id: null });
  assert.deepEqual(all("SELECT api_key_id FROM user_keys"), [{ api_key_id: 1 }]);
  assert.deepEqual(get("SELECT api_key_id FROM conversations WHERE id = 'chat-2'"), { api_key_id: null });
  assert.deepEqual(all("SELECT api_key_id FROM usage_events"), [{ api_key_id: null }]);
  assert.deepEqual(get("SELECT fallback_key_id FROM api_keys WHERE id = 1"), { fallback_key_id: null });
});
