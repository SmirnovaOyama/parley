// Real comparison and chat routes, a temporary SQLite database, signed-in sessions, and a local
// OpenAI-compatible provider. Nothing in this test uses a real account or leaves the machine.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { sameOriginGuard, sessionMiddleware, type AppEnv } from "../server/auth.ts";
import { historyAttachments, saveUpload } from "../server/attachments.ts";
import { encryptSecret, hashToken } from "../server/crypto.ts";
import { db, nowIso } from "../server/db.ts";
import { env } from "../server/env.ts";
import { getProvider } from "../server/providers/index.ts";
import type { ChatRequest, ChatResult } from "../server/providers/types.ts";
import { purgeConversations } from "../server/retention.ts";
import { chatRoutes } from "../server/routes/chat.ts";
import { chunk, completionStream, json, mockServer, usageChunk, type MockServer, type Reply } from "./helpers/mock-server.ts";
import { PNG } from "./helpers/chat.ts";

const app = new Hono<AppEnv>();
app.use("*", sameOriginGuard, sessionMiddleware);
app.route("/api", chatRoutes);
let service: MockServer;
let keyId: number;
let privateKeyId: number;
const failures = new Set<string>();
const held: (() => void)[] = [];
let hold = false;
let rememberAlpha = false;

function addKey(label: string, shared: number) {
  return Number(db.prepare(
    `INSERT INTO api_keys (label, provider, model, effort, encrypted_key, last4, shared, endpoint, models, created_at)
     VALUES (?, 'custom', 'alpha', 'default', ?, 'test', ?, ?, ?, ?)`,
  ).run(label, encryptSecret("sk-test"), shared, JSON.stringify({
    baseUrl: `${service.url}/v1`, images: false,
    models: ["alpha", "beta", "gamma"].map((id) => ({ id, input: 1, output: 2 })),
  }), JSON.stringify(["alpha", "beta", "gamma"]), nowIso()).lastInsertRowid);
}

before(async () => {
  service = await mockServer((req) => {
    assert.equal(req.path, "/v1/chat/completions");
    if (failures.has(req.body.model)) return json({ error: { message: "Unavailable" } }, 404);
    if (!req.body.stream) return json({ choices: [{ message: { content: "A normal chat" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    if (rememberAlpha && req.body.model === "alpha" && req.body.messages.at(-1)?.role === "user") {
      return completionStream([
        chunk({ tool_calls: [{ index: 0, id: "remember_1", type: "function", function: { name: "memory", arguments: JSON.stringify({ action: "save", text: "Enjoys chemistry lessons" }) } }] }),
        chunk({}, "tool_calls"),
      ]);
    }
    const reply = completionStream([
      chunk({ content: `Reply from ${req.body.model}` }), chunk({}, "stop"),
      usageChunk({ prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 }),
    ]);
    return hold ? new Promise<Reply>((resolve) => held.push(() => resolve(reply))) : reply;
  });
  keyId = addKey("Comparison models", 1);
  privateKeyId = addKey("Private models", 0);
});
after(async () => { held.splice(0).forEach((release) => release()); await service.close(); });

class Person {
  id: number;
  token = randomUUID();
  constructor() {
    this.id = Number(db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, 'test', ?)")
      .run(`${randomUUID()}@example.com`, nowIso()).lastInsertRowid);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(this.token), this.id, new Date(Date.now() + 86_400_000).toISOString(), nowIso());
  }
  request(method: string, path: string, body?: unknown) {
    return app.request(`http://parley.test/api${path}`, {
      method, headers: { cookie: `sid=${this.token}`, origin: "http://parley.test", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async json(method: string, path: string, body?: unknown) {
    const res = await this.request(method, path, body);
    return { status: res.status, body: await res.json() as any };
  }
  async create(count = 2, extra: Record<string, unknown> = {}) {
    const res = await this.json("POST", "/comparisons", { text: "Compare this question", choices: choices(count), ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Comparison;
  }
  async chat(body: Record<string, unknown>) {
    const res = await this.request("POST", "/chat", body);
    assert.equal(res.status, 200, await res.clone().text());
    return events(await res.text());
  }
}

type Run = { conversationId: string; promptMessageId: number; choice: { keyId: number; model: string; effort: string }; messages: any[]; deleted: boolean; continued: boolean; generating: boolean; asks: unknown[] };
type Comparison = { id: string; title: string; text: string; runs: Run[] };
const choices = (n = 2) => ["alpha", "beta", "gamma"].slice(0, n).map((model) => ({ keyId, model, effort: "default" }));
const requestFor = (comparison: Comparison, run: Run) => ({ comparisonId: comparison.id, conversationId: run.conversationId, regenerate: run.promptMessageId, ...run.choice });
const events = (text: string) => text.split("\n\n").filter((s) => s.startsWith("event:")).map((s) => ({
  event: s.split("\n")[0].slice(7), data: JSON.parse(s.split("\n").find((line) => line.startsWith("data: "))!.slice(6)),
}));
const count = (table: string, userId: number) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number }).n;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the local provider");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("persists three independent chats with the same initial persona, project, knowledge, memory and files, and bills each reply", async () => {
  const person = new Person();
  const now = nowIso();
  const persona = randomUUID();
  const project = randomUUID();
  const knowledge = randomUUID();
  db.prepare("INSERT INTO personas (id, user_id, name, about_me, answer_style, created_at, updated_at) VALUES (?, ?, 'Me', 'A teacher', 'Keep it clear', ?, ?)").run(persona, person.id, now, now);
  db.prepare("UPDATE users SET persona_id = ? WHERE id = ?").run(persona, person.id);
  db.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at, updated_at) VALUES (?, ?, 'Science', 'Explain the experiments', ?, ?)").run(project, person.id, now, now);
  db.prepare("INSERT INTO knowledge_bases (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Lesson notes', ?, ?)").run(knowledge, person.id, now, now);
  db.prepare("INSERT INTO memories (user_id, text, created_at, updated_at) VALUES (?, 'Prefers metric units', ?, ?)").run(person.id, now, now);
  const file = saveUpload(person.id, "lesson.txt", Buffer.from("A lesson about water"));
  assert.ok("id" in file);
  const comparison = await person.create(3, { projectId: project, knowledgeIds: [knowledge], attachments: [file.id] });
  assert.equal(new Set(comparison.runs.map((r) => r.conversationId)).size, 3);
  assert.equal(new Set(comparison.runs.map((r) => r.promptMessageId)).size, 3);
  assert.equal(new Set(comparison.runs.map((r) => r.messages[0].attachments[0].id)).size, 3);
  const persisted = new DatabaseSync(env.databasePath);
  assert.equal((persisted.prepare("SELECT COUNT(*) AS n FROM comparison_runs WHERE comparison_id = ?").get(comparison.id) as { n: number }).n, 3);
  persisted.close();
  const systems = comparison.runs.map((run) => db.prepare("SELECT system_prompt, tool_defs, title_auto FROM conversations WHERE id = ?").get(run.conversationId) as { system_prompt: string; tool_defs: string; title_auto: number });
  assert.equal(new Set(systems.map((row) => row.system_prompt)).size, 1);
  for (const word of ["A teacher", "Keep it clear", "Science", "Explain the experiments", "Lesson notes", "Prefers metric units"]) assert.ok(systems[0].system_prompt.includes(word));
  assert.ok(systems.every((row) => row.title_auto === 0 && row.tool_defs.includes("search_knowledge")));
  const before = service.requests.length;
  await Promise.all(comparison.runs.map((run) => person.chat(requestFor(comparison, run))));
  const sent = service.requests.slice(before);
  assert.equal(sent.length, 3, "No additional model calls for titles");
  assert.ok(sent.every((request) => request.body.messages.filter((m: { role: string }) => m.role === "assistant").length === 0));
  const restored = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
  assert.deepEqual(restored.runs.map((run) => run.messages[1].text), ["Reply from alpha", "Reply from beta", "Reply from gamma"]);
  assert.ok(restored.runs.every((run) => run.messages.length === 2 && !run.deleted && !run.continued && !run.generating));
  const usage = db.prepare("SELECT model, input_tokens, output_tokens, cost_usd FROM usage_events WHERE user_id = ? ORDER BY model").all(person.id);
  assert.deepEqual(usage.map((row) => ({ ...row })), ["alpha", "beta", "gamma"].map((model) => ({ model, input_tokens: 100, output_tokens: 25, cost_usd: 0.00015 })));
  assert.equal((await person.json("GET", "/comparisons")).body.comparisons[0].id, comparison.id);
});

test("rejects invalid, duplicate or inaccessible selections and incompatible files before creating any chats", async () => {
  const person = new Person();
  const baseline = count("conversations", person.id);
  const invalid = [
    [], choices(1), [...choices(3), choices()[0]], [choices()[0], choices()[0]],
    [choices()[0], { ...choices()[1], keyId: privateKeyId }],
    [choices()[0], { ...choices()[1], model: "missing" }],
    [choices()[0], { ...choices()[1], effort: "invalid" }],
    [choices()[0], { ...choices()[1], keyId: String(keyId) }],
  ];
  for (const selection of invalid) assert.equal((await person.json("POST", "/comparisons", { text: "Question", choices: selection })).status, 400);
  const file = saveUpload(person.id, "picture.png", PNG);
  assert.ok("id" in file);
  assert.equal((await person.json("POST", "/comparisons", { text: "Question", choices: choices(), attachments: [file.id] })).status, 400);
  assert.equal((await person.json("POST", "/comparisons", { text: "Question", choices: choices(), knowledgeIds: ["other"] })).status, 400);
  assert.equal(count("conversations", person.id), baseline);
  assert.equal(count("comparisons", person.id), 0);
  db.prepare("UPDATE users SET monthly_token_limit = 0 WHERE id = ?").run(person.id);
  assert.equal((await person.json("POST", "/comparisons", { text: "Question", choices: choices() })).status, 429);
});

test("requires a session and owns every comparison, slot, prompt and selected model", async () => {
  assert.equal((await app.request("http://parley.test/api/comparisons")).status, 401);
  const owner = new Person();
  const other = new Person();
  const comparison = await owner.create();
  const request = requestFor(comparison, comparison.runs[0]);
  assert.equal((await other.json("GET", `/comparisons/${comparison.id}`)).status, 404);
  assert.deepEqual((await other.json("GET", "/comparisons")).body.comparisons, []);
  assert.equal((await other.json("POST", "/chat", request)).status, 404);
  for (const change of [{ model: "beta" }, { keyId: privateKeyId }, { effort: "low" }, { regenerate: comparison.runs[1].promptMessageId }]) {
    assert.equal((await owner.json("POST", "/chat", { ...request, ...change })).status, 400);
  }
  const different = await owner.create();
  assert.equal((await owner.json("POST", "/chat", { ...request, comparisonId: different.id })).status, 400);
  assert.equal(count("usage_events", owner.id), 0);
});

test("keeps successful columns when one fails, never uses its backup, and retries only that original question", async () => {
  const person = new Person();
  const comparison = await person.create();
  db.prepare("UPDATE api_keys SET fallback_key_id = ? WHERE id = ?").run(privateKeyId, keyId);
  failures.add("beta");
  const before = service.requests.length;
  try {
    await Promise.all(comparison.runs.map((run) => person.chat(requestFor(comparison, run))));
    const failed = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
    assert.deepEqual(failed.runs.map((run) => run.messages[1].status), ["ok", "failed"]);
    assert.equal(service.requests.length - before, 2, "A comparison never switches to a backup key");
    const kept = failed.runs[0].messages[1].id;
    failures.delete("beta");
    await person.chat(requestFor(comparison, comparison.runs[1]));
    const retried = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
    assert.equal(retried.runs[0].messages[1].id, kept);
    assert.equal(retried.runs[1].messages[1].status, "ok");
    assert.equal(retried.runs[1].messages[0].id, comparison.runs[1].promptMessageId);
    assert.equal(retried.runs[1].messages[1].siblingIds.length, 2);
    assert.equal(count("usage_events", person.id), 2);
    db.prepare("UPDATE api_keys SET models = ? WHERE id = ?").run('["alpha"]', keyId);
    assert.equal((await person.json("POST", "/chat", requestFor(comparison, comparison.runs[1]))).status, 409);
    db.prepare("UPDATE users SET monthly_token_limit = 1 WHERE id = ?").run(person.id);
    assert.equal((await person.json("POST", "/chat", requestFor(comparison, comparison.runs[0]))).status, 429);
  } finally {
    failures.clear();
    db.prepare("UPDATE api_keys SET fallback_key_id = NULL, models = ? WHERE id = ?").run('["alpha","beta","gamma"]', keyId);
  }
});

test("continues each ordinary chat independently without changing or retrying its original comparison", async () => {
  const person = new Person();
  const comparison = await person.create();
  await Promise.all(comparison.runs.map((run) => person.chat(requestFor(comparison, run))));
  const initial = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
  await person.chat({ conversationId: comparison.runs[0].conversationId, text: "Explain alpha in more detail" });
  const viewed = (await person.json("GET", `/conversations/${comparison.runs[0].conversationId}`)).body;
  assert.equal(viewed.conversation.comparisonId, comparison.id);
  assert.equal(viewed.messages.length, 4);
  const compared = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
  assert.deepEqual(compared.runs.map((run) => run.messages), initial.runs.map((run) => run.messages));
  assert.deepEqual(compared.runs.map((run) => run.continued), [true, false]);
  assert.equal((await person.json("POST", "/chat", requestFor(comparison, comparison.runs[0]))).status, 409);
  assert.equal((await person.json("GET", `/conversations/${comparison.runs[1].conversationId}`)).body.messages.length, 2);
});

test("preserves the other columns' attachments when a chat is purged and removes the group after the last chat is deleted", async () => {
  const person = new Person();
  const file = saveUpload(person.id, "notes.txt", Buffer.from("Shared file contents"));
  assert.ok("id" in file);
  const comparison = await person.create(2, { attachments: [file.id] });
  const path = historyAttachments(comparison.runs[0].promptMessageId)[0].path;
  purgeConversations([comparison.runs[0].conversationId]);
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(historyAttachments(comparison.runs[1].promptMessageId)[0].path, "utf8"), "Shared file contents");
  const deleted = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
  assert.deepEqual(deleted.runs.map((run) => run.deleted), [true, false]);
  assert.deepEqual(deleted.runs[0].messages, []);
  await person.chat(requestFor(comparison, comparison.runs[1]));
  assert.equal((await person.json("DELETE", `/conversations/${comparison.runs[1].conversationId}`)).status, 200);
  assert.equal((await person.json("GET", `/comparisons/${comparison.id}`)).status, 404);
  assert.equal(count("comparisons", person.id), 0);
  purgeConversations([comparison.runs[1].conversationId]);
  assert.equal(existsSync(path), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comparison_runs WHERE comparison_id = ?").get(comparison.id) as { n: number }).n, 0);
});

test("regenerating in the ordinary chat keeps its new branch without replacing the saved comparison answer", async () => {
  const person = new Person();
  const comparison = await person.create();
  const run = comparison.runs[0];
  await person.chat(requestFor(comparison, run));
  const initial = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
  await person.chat({ conversationId: run.conversationId, regenerate: run.promptMessageId, ...run.choice });
  const compared = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
  assert.equal(compared.runs[0].messages[1].id, initial.runs[0].messages[1].id);
  assert.equal(compared.runs[0].continued, true);
  const ordinary = (await person.json("GET", `/conversations/${run.conversationId}`)).body;
  assert.notEqual(ordinary.messages[1].id, compared.runs[0].messages[1].id);
  assert.equal((await person.json("POST", "/chat", requestFor(comparison, run))).status, 409);
  assert.equal((await person.json("GET", `/conversations/${run.conversationId}`)).body.messages[1].id, ordinary.messages[1].id);
});

test("uses the existing three-reply limit, saves disconnected replies, and stops a column independently", async () => {
  const person = new Person();
  const comparison = await person.create(3);
  hold = true;
  try {
    const responses = await Promise.all(comparison.runs.map((run) => person.request("POST", "/chat", requestFor(comparison, run))));
    const reads = responses.map((res) => res.text());
    await until(() => held.length === 3);
    const active = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
    assert.ok(active.runs.every((run) => run.generating));
    assert.equal((await person.json("POST", "/chat", { text: "A fourth reply" })).status, 429);
    await person.json("POST", `/conversations/${comparison.runs[0].conversationId}/stop`, {});
    hold = false;
    held.splice(0).forEach((release) => release());
    await Promise.all(reads);
    const stopped = (await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison;
    assert.equal(stopped.runs[0].messages[1].status, "stopped");
    assert.ok(stopped.runs.slice(1).every((run) => run.messages[1].status === "ok"));

    hold = true;
    const res = await person.request("POST", "/chat", requestFor(comparison, comparison.runs[0]));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await until(() => held.length === 1);
    hold = false;
    held.splice(0).forEach((release) => release());
    await until(async () => ((await person.json("GET", `/comparisons/${comparison.id}`)).body as Comparison).runs[0].messages[1].status === "ok");
    assert.equal(count("usage_events", person.id), 3);
  } finally {
    hold = false;
    held.splice(0).forEach((release) => release());
  }
});

test("keeps a tool approval attached to its own comparison column", async () => {
  const person = new Person();
  const other = new Person();
  const file = saveUpload(person.id, "notes.txt", Buffer.from("Some outside text"));
  assert.ok("id" in file);
  const comparison = await person.create(2, { attachments: [file.id] });
  rememberAlpha = true;
  try {
    const response = await person.request("POST", "/chat", requestFor(comparison, comparison.runs[0]));
    const read = response.text();
    let active: Comparison = comparison;
    await until(async () => {
      active = (await person.json("GET", `/comparisons/${comparison.id}`)).body;
      return active.runs[0].asks.length === 1;
    });
    assert.equal(active.runs[0].generating, true);
    assert.deepEqual(active.runs[1].asks, []);
    const ask = active.runs[0].asks[0] as { id: string };
    const path = `/conversations/${comparison.runs[0].conversationId}/asks/${ask.id}`;
    assert.equal((await other.json("POST", path, { allow: true })).status, 404);
    assert.equal(count("memories", person.id), 0);
    assert.equal((await person.json("POST", path, { allow: true })).status, 200);
    assert.ok(events(await read).some((event) => event.event === "done"));
    assert.equal(count("memories", person.id), 1);
    assert.deepEqual((await person.json("GET", `/comparisons/${comparison.id}`)).body.runs[0].asks, []);
  } finally {
    rememberAlpha = false;
    await person.json("POST", `/conversations/${comparison.runs[0].conversationId}/stop`, {});
  }
});

test("requires the exact provider model and leaves missing-file retries explicit after a side effect", async (t) => {
  const person = new Person();
  const now = nowIso();
  const secret = "sk-comparison-test";
  const anthropicKey = Number(db.prepare(
    `INSERT INTO api_keys (label, provider, model, effort, encrypted_key, last4, shared, created_at)
     VALUES ('Exact Claude', 'anthropic', 'claude-sonnet-5-5', 'low', ?, 'test', 1, ?)`,
  ).run(encryptSecret(secret), now).lastInsertRowid);
  const file = saveUpload(person.id, "notes.txt", Buffer.from("Read this document"));
  assert.ok("id" in file);
  const comparison = await person.create(2, { attachments: [file.id], choices: [
    { keyId: anthropicKey, model: "claude-sonnet-5-5", effort: "low" }, choices()[0],
  ] });
  const attachment = historyAttachments(comparison.runs[0].promptMessageId)[0];
  const account = createHash("sha256").update(secret).digest("hex").slice(0, 32);
  db.prepare("INSERT INTO provider_files (account, sha256, name, file_id, created_at) VALUES (?, ?, ?, 'file-test', ?)")
    .run(account, attachment.sha256, attachment.name, now);
  let calls = 0;
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("No external requests in this test"); });
  t.mock.method(getProvider("anthropic"), "chat", async (req: ChatRequest) => {
    calls++;
    assert.equal(req.exactModel, true);
    db.prepare("INSERT INTO memories (user_id, text, created_at, updated_at) VALUES (?, 'A completed action', ?, ?)").run(person.id, now, now);
    throw Object.assign(new Error("file not found"), { status: 404 });
  });
  const stream = await person.chat(requestFor(comparison, comparison.runs[0]));
  assert.equal(stream.at(-1)?.event, "error");
  assert.equal(calls, 1);
  assert.equal(networkCalls, 0, "No automatic re-upload or repeated provider attempt");
  assert.equal(count("memories", person.id), 1);
  assert.ok(db.prepare("SELECT 1 FROM provider_files WHERE account = ? AND sha256 = ? AND name = ?").get(account, attachment.sha256, attachment.name));
});

test("marks partial results stopped and keeps their usage when a provider returns normally after abort", async (t) => {
  let started = 0;
  t.mock.method(getProvider("custom"), "chat", async (req: ChatRequest): Promise<ChatResult> => {
    started++;
    req.onText("The partial reply");
    await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
    return {
      text: "The partial reply", thinking: "", content: null, model: req.model, stopReason: "stop", refused: false,
      usage: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0 }, searches: [], sources: [], found: [],
      fileIds: [], container: null, contextTokens: 125,
    };
  });
  for (const comparisonMode of [true, false]) {
    const person = new Person();
    const comparison = comparisonMode ? await person.create() : null;
    const body = comparison ? requestFor(comparison, comparison.runs[0]) : { text: "Stop this ordinary chat", ...choices()[0] };
    const before = started;
    const response = await person.request("POST", "/chat", body);
    const read = response.text();
    await until(() => started > before);
    const conversationId = comparison?.runs[0].conversationId ?? (await person.json("GET", "/conversations")).body.conversations[0].id;
    assert.equal((await person.json("POST", `/conversations/${conversationId}/stop`, {})).status, 200);
    const done = events(await read).find((event) => event.event === "done")?.data.message;
    assert.equal(done?.status, "stopped");
    assert.equal(done?.text, "The partial reply");
    assert.equal(done?.contextTokens, 125);
    assert.equal((await person.json("GET", `/conversations/${conversationId}`)).body.messages.at(-1).status, "stopped");
    if (comparison) assert.equal((await person.json("GET", `/comparisons/${comparison.id}`)).body.runs[0].messages[1].status, "stopped");
    assert.equal(count("usage_events", person.id), 1);
    assert.deepEqual({ ...db.prepare("SELECT input_tokens, output_tokens, cost_usd FROM usage_events WHERE user_id = ?").get(person.id) }, {
      input_tokens: 100, output_tokens: 25, cost_usd: 0.00015,
    });
  }
});
