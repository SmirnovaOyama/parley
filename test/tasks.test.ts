// Durable task routes and scheduler use a throwaway database and a local provider only
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, mock, test } from "node:test";
import { Hono } from "hono";
import { sameOriginGuard, sessionMiddleware, type AppEnv } from "../server/auth.ts";
import { encryptSecret, hashToken } from "../server/crypto.ts";
import { db, nowIso } from "../server/db.ts";
import { chatRoutes } from "../server/routes/chat.ts";
import type { TaskSchedule } from "../server/schedule-time.ts";
import { taskRoutes, tickTasks, recoverTaskRuns, waitForTaskRuns } from "../server/tasks.ts";
import { chunk, completionStream, json, mockServer, usageChunk, type MockServer, type Reply } from "./helpers/mock-server.ts";

const app = new Hono<AppEnv>();
app.use("*", sameOriginGuard, sessionMiddleware);
app.route("/api", taskRoutes);
app.route("/api", chatRoutes);
let service: MockServer;
let keyId: number;
let privateKeyId: number;
let hold = false;
const held: (() => void)[] = [];
const failures = new Set<string>();
let requestedTools: string[] = [];
const DAY = 86_400_000;
const daily: TaskSchedule = { kind: "daily", timeZone: "Asia/Singapore", time: "09:00" };
type ScheduledTask = {
  id: string; name: string; prompt: string; enabled: boolean; email: boolean; nextRunAt: string | null;
  schedule: TaskSchedule; choice: { keyId: number; model: string; effort: string };
};
type TaskDetail = ScheduledTask & { runs: {
  id: string; trigger: "manual" | "scheduled"; scheduledFor: string;
  finishedAt: string | null; conversationId: string | null; status: string; error: string | null;
}[] };

function addKey(label: string, shared: number) {
  return Number(db.prepare(
    `INSERT INTO api_keys (label, provider, model, effort, encrypted_key, last4, shared, endpoint, models, created_at)
     VALUES (?, 'custom', 'alpha', 'default', ?, 'test', ?, ?, ?, ?)`,
  ).run(label, encryptSecret("sk-local-task-test"), shared, JSON.stringify({
    baseUrl: `${service.url}/v1`, images: false,
    models: ["alpha", "beta"].map((id) => ({ id, input: 1, output: 2 })),
  }), JSON.stringify(["alpha", "beta"]), nowIso()).lastInsertRowid);
}

before(async () => {
  service = await mockServer((req) => {
    assert.equal(req.path, "/v1/chat/completions");
    if (failures.has(req.body.model)) return json({ error: { message: "Synthetic task failure" } }, 404);
    if (!req.body.stream) return json({ choices: [{ message: { content: "Task output" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    if (requestedTools.length && req.body.messages.at(-1)?.role === "user") {
      return completionStream([
        chunk({ tool_calls: requestedTools.map((name, index) => ({
          index, id: `tool_${index}`, type: "function", function: {
            name, arguments: JSON.stringify(name === "memory" ? { action: "save", text: "Enjoys chemistry lessons" } : {}),
          },
        })) }),
        chunk({}, "tool_calls"),
      ]);
    }
    const reply = completionStream([
      chunk({ content: `Scheduled reply from ${req.body.model}` }), chunk({}, "stop"),
      usageChunk({ prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 }),
    ]);
    return hold ? new Promise<Reply>((resolve) => held.push(() => resolve(reply))) : reply;
  });
  keyId = addKey("Task models", 1);
  privateKeyId = addKey("Private task models", 0);
});

afterEach(async () => {
  hold = false;
  held.splice(0).forEach((release) => release());
  await waitForTaskRuns();
  failures.clear();
  requestedTools = [];
  db.prepare("UPDATE scheduled_tasks SET enabled = 0").run();
  db.prepare("UPDATE api_keys SET shared = 1, models = ?, fallback_key_id = NULL WHERE id = ?").run('["alpha","beta"]', keyId);
  db.prepare("UPDATE api_keys SET shared = 0, model = 'alpha', models = ?, fallback_key_id = NULL WHERE id = ?").run('["alpha","beta"]', privateKeyId);
  db.prepare("DELETE FROM mcp_servers").run();
});
after(async () => { held.splice(0).forEach((release) => release()); await service.close(); });

class Person {
  id: number;
  token = randomUUID();
  constructor() {
    this.id = Number(db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, 'test', ?)")
      .run(`${randomUUID()}@example.com`, nowIso()).lastInsertRowid);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(this.token), this.id, new Date(Date.now() + DAY).toISOString(), nowIso());
  }
  request(method: string, path: string, body?: unknown) {
    return app.request(`http://parley.test/api${path}`, {
      method, headers: { cookie: `sid=${this.token}`, origin: "http://parley.test", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async json(method: string, path: string, body?: unknown) {
    const response = await this.request(method, path, body);
    return { status: response.status, body: await response.json() as any };
  }
  async create(extra: Record<string, unknown> = {}): Promise<TaskDetail> {
    const response = await this.json("POST", "/tasks", {
      name: "Morning notes", prompt: "Explain this day's lesson clearly", choice: { keyId, model: "alpha", effort: "default" },
      schedule: daily, ...extra,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async detail(id: string): Promise<TaskDetail> {
    const response = await this.json("GET", `/tasks/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async run(id: string) {
    const response = await this.json("POST", `/tasks/${id}/run`, {});
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(response.body.run.trigger, "manual");
    return response.body.run;
  }
}

const calls = () => service.requests.filter((request) => request.body?.stream === true);
const count = (table: string, userId: number) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number }).n;
const runRows = (taskId: string) => db.prepare("SELECT * FROM scheduled_runs WHERE task_id = ? ORDER BY started_at, id").all(taskId);
const due = (task: ScheduledTask) => {
  assert.ok(task.nextRunAt);
  return Date.parse(task.nextRunAt);
};
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the local task provider");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("task CRUD requires a session and keeps every operation within its owner", async () => {
  assert.equal((await app.request("http://parley.test/api/tasks")).status, 401);
  const owner = new Person();
  const other = new Person();
  const task = await owner.create();
  assert.equal(task.name, "Morning notes");
  assert.deepEqual(task.schedule, daily);
  assert.equal(task.enabled, true);
  assert.equal((await owner.json("GET", "/tasks")).body.tasks[0].id, task.id);
  assert.deepEqual((await other.json("GET", "/tasks")).body.tasks, []);
  for (const [method, path, body] of [
    ["GET", `/tasks/${task.id}`],
    ["PUT", `/tasks/${task.id}`, { name: "Other", prompt: "Other", choice: task.choice, schedule: daily }],
    ["PATCH", `/tasks/${task.id}`, { enabled: false }],
    ["POST", `/tasks/${task.id}/run`, {}],
    ["POST", `/tasks/${task.id}/stop`, {}],
    ["DELETE", `/tasks/${task.id}`],
  ] as const) assert.equal((await other.json(method, path, body)).status, 404, `${method} ${path}`);
  const changed = await owner.json("PUT", `/tasks/${task.id}`, { name: "Weekly notes", prompt: "Review this week's lessons", choice: task.choice, schedule: { ...daily, kind: "weekly", days: [1, 5] } });
  assert.equal(changed.status, 200);
  const saved = await owner.detail(task.id);
  assert.equal(saved.name, "Weekly notes");
  assert.equal(saved.prompt, "Review this week's lessons");
  assert.deepEqual(saved.schedule.days, [1, 5]);
  assert.equal((await owner.json("DELETE", `/tasks/${task.id}`)).status, 200);
  assert.equal((await owner.json("GET", `/tasks/${task.id}`)).status, 404);
});

test("invalid task input is rejected before saving tasks or starting model calls", async () => {
  const person = new Person();
  const base = { name: "Morning", prompt: "A question", choice: { keyId, model: "alpha", effort: "default" }, schedule: daily };
  const invalid = [
    { name: " " }, { prompt: " " }, { schedule: { ...daily, timeZone: "Missing/Zone" } },
    { schedule: { ...daily, kind: "weekly", days: [] } },
    { choice: { ...base.choice, keyId: privateKeyId } },
    { choice: { ...base.choice, model: "missing" } },
    { choice: { ...base.choice, effort: "invalid" } },
    { choice: { ...base.choice, keyId: String(keyId) } },
  ];
  const before = calls().length;
  for (const change of invalid) {
    const response = await person.json("POST", "/tasks", { ...base, ...change });
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  assert.equal(count("scheduled_tasks", person.id), 0);
  assert.equal(count("conversations", person.id), 0);
  assert.equal(calls().length, before);
});

test("the 50-task limit remains atomic when two creates race for the last available slot", async () => {
  const person = new Person();
  const body = { name: "Boundary task", prompt: "A scheduled question", choice: { keyId, model: "alpha", effort: "default" }, schedule: daily };
  const before = calls().length;
  try {
    for (let index = 0; index < 49; index++) await person.create({ name: `Existing task ${index + 1}` });
    assert.equal(count("scheduled_tasks", person.id), 49);
    const responses = await Promise.all([
      person.json("POST", "/tasks", { ...body, name: "Concurrent first" }),
      person.json("POST", "/tasks", { ...body, name: "Concurrent second" }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(count("scheduled_tasks", person.id), 50);
    assert.equal((await person.json("GET", "/tasks")).body.tasks.length, 50);
    assert.equal((await person.json("POST", "/tasks", body)).status, 409);
    const accepted = responses.find((response) => response.status === 200)!;
    assert.equal((await person.json("DELETE", `/tasks/${accepted.body.id}`)).status, 200);
    assert.equal((await person.json("POST", "/tasks", body)).status, 200);
    assert.equal(count("scheduled_tasks", person.id), 50);
    assert.equal(calls().length, before);
  } finally {
    db.prepare("DELETE FROM scheduled_tasks WHERE user_id = ?").run(person.id);
  }
  assert.equal(count("scheduled_tasks", person.id), 0);
});

test("one-time tasks create an ordinary saved chat, bill its reply, and never repeat", async () => {
  const person = new Person();
  const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  const task = await person.create({ schedule: { kind: "once", timeZone: "UTC", date: tomorrow, time: "09:00" } });
  const scheduledFor = task.nextRunAt;
  const when = due(task);
  const before = calls().length;
  await tickTasks(when - 1);
  assert.equal(calls().length, before);
  await tickTasks(when);
  const saved = await person.detail(task.id);
  assert.equal(saved.runs.length, 1);
  const run = saved.runs[0];
  assert.equal(run.trigger, "scheduled");
  assert.equal(run.scheduledFor, scheduledFor);
  assert.equal(run.status, "succeeded", JSON.stringify(run));
  assert.ok(run.finishedAt);
  assert.ok(run.conversationId);
  assert.equal(saved.nextRunAt, null);
  const messages = db.prepare("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id").all(run.conversationId);
  assert.deepEqual(messages.map((message) => ({ ...message })), [
    { role: "user", text: task.prompt }, { role: "assistant", text: "Scheduled reply from alpha" },
  ]);
  const usage = db.prepare("SELECT model, input_tokens, output_tokens, cost_usd FROM usage_events WHERE user_id = ?").all(person.id);
  assert.deepEqual(usage.map((row) => ({ ...row })), [{ model: "alpha", input_tokens: 100, output_tokens: 25, cost_usd: 0.00015 }]);
  await tickTasks(when + 7 * DAY);
  assert.equal(calls().length - before, 1);
  assert.equal((await person.detail(task.id)).runs.length, 1);
});

test("concurrent scheduler ticks atomically claim each occurrence once", async () => {
  const person = new Person();
  const task = await person.create();
  const when = due(task);
  const before = calls().length;
  hold = true;
  const ticks = [tickTasks(when), tickTasks(when), tickTasks(when)];
  await until(() => held.length === 1);
  assert.equal(runRows(task.id).length, 1);
  assert.equal(runRows(task.id)[0].status, "running");
  assert.equal(calls().length - before, 1);
  hold = false;
  held.splice(0).forEach((release) => release());
  await Promise.all(ticks);
  assert.equal((await person.detail(task.id)).runs.length, 1);
  assert.ok(due(await person.detail(task.id)) > when);
});

test("four tasks due together preserve the fourth occurrence until capacity is available", async () => {
  const person = new Person();
  const tasks: TaskDetail[] = [];
  for (let index = 0; index < 4; index++) tasks.push(await person.create({ name: `Same time ${index + 1}` }));
  const when = Math.max(...tasks.map(due));
  const before = calls().length;
  hold = true;
  const firstTick = tickTasks(when);
  await until(() => held.length === 3);
  const waiting = tasks.filter((task) => runRows(task.id).length === 0);
  assert.equal(waiting.length, 1, "The task without a free reply slot must not be claimed");
  const pending = await person.detail(waiting[0].id);
  assert.equal(pending.enabled, true);
  assert.equal(pending.nextRunAt, waiting[0].nextRunAt);
  assert.equal(calls().length - before, 3);
  hold = false;
  held.splice(0).forEach((release) => release());
  await firstTick;
  await tickTasks(when);
  await tickTasks(when);
  assert.equal(calls().length - before, 4);
  assert.equal(count("conversations", person.id), 4);
  for (const task of tasks) {
    const saved = await person.detail(task.id);
    assert.equal(saved.runs.length, 1);
    assert.equal(saved.runs[0].status, "succeeded");
    assert.equal(saved.runs[0].scheduledFor, task.nextRunAt);
    assert.ok(due(saved) > when);
  }
});

test("manual runs keep the schedule intact and use a fresh conversation every time", async () => {
  const person = new Person();
  const task = await person.create();
  const before = calls().length;
  await person.run(task.id);
  await waitForTaskRuns();
  await person.run(task.id);
  await waitForTaskRuns();
  const saved = await person.detail(task.id);
  assert.equal(saved.nextRunAt, task.nextRunAt);
  assert.equal(saved.runs.length, 2);
  assert.ok(saved.runs.every((run) => run.trigger === "manual" && run.status === "succeeded"));
  assert.equal(new Set(saved.runs.map((run) => run.conversationId)).size, 2);
  assert.equal(count("conversations", person.id), 2);
  assert.equal(count("usage_events", person.id), 2);
  for (const request of calls().slice(before)) {
    assert.equal(request.body.messages.filter((message: { role: string }) => message.role === "assistant").length, 0);
    assert.equal(request.body.messages.filter((message: { role: string }) => message.role === "user").length, 1);
  }
});

test("pause affects future occurrences while manual execution and resuming remain available", async () => {
  const person = new Person();
  const task = await person.create();
  const when = due(task);
  assert.equal((await person.json("PATCH", `/tasks/${task.id}`, { enabled: false })).status, 200);
  await tickTasks(when + DAY);
  assert.equal((await person.detail(task.id)).runs.length, 0);
  await person.run(task.id);
  await waitForTaskRuns();
  assert.equal((await person.detail(task.id)).enabled, false);
  assert.equal((await person.detail(task.id)).runs[0].status, "succeeded");
  const beforeResume = Date.now();
  assert.equal((await person.json("PATCH", `/tasks/${task.id}`, { enabled: true })).status, 200);
  const resumed = await person.detail(task.id);
  assert.equal(resumed.enabled, true);
  assert.ok(due(resumed) > beforeResume);
  assert.deepEqual(resumed.schedule, task.schedule);
});

test("an overdue recurring task catches up once and schedules the next future occurrence", async () => {
  const person = new Person();
  const task = await person.create();
  const now = due(task) + 4 * DAY + 60_000;
  const before = calls().length;
  await tickTasks(now);
  const saved = await person.detail(task.id);
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].scheduledFor, task.nextRunAt);
  assert.ok(due(saved) > now);
  await tickTasks(now);
  assert.equal(calls().length - before, 1);
  assert.equal((await person.detail(task.id)).runs.length, 1);
});

test("restart marks an unfinished run interrupted without replaying the claimed occurrence", async () => {
  const person = new Person();
  const task = await person.create();
  const past = new Date(Date.now() - DAY).toISOString();
  const runId = randomUUID();
  db.prepare("INSERT INTO scheduled_runs (id, task_id, trigger, scheduled_for, started_at, status) VALUES (?, ?, 'scheduled', ?, ?, 'running')")
    .run(runId, task.id, past, past);
  const before = calls().length;
  recoverTaskRuns();
  const saved = await person.detail(task.id);
  assert.equal(saved.runs[0].id, runId);
  assert.equal(saved.runs[0].status, "interrupted");
  assert.ok(saved.runs[0].finishedAt);
  assert.equal(saved.nextRunAt, task.nextRunAt);
  await tickTasks(Date.now());
  assert.equal(calls().length, before);
  assert.equal((await person.detail(task.id)).runs.length, 1);
});

test("scheduled execution rechecks disabled users, revoked keys, available models and allowance", async () => {
  const checks = [
    (person: Person) => db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(person.id),
    (person: Person) => db.prepare("DELETE FROM user_keys WHERE user_id = ? AND api_key_id = ?").run(person.id, privateKeyId),
    (person: Person) => db.prepare("UPDATE users SET monthly_token_limit = 0 WHERE id = ?").run(person.id),
    () => db.prepare("UPDATE api_keys SET model = 'beta', models = ? WHERE id = ?").run('["beta"]', privateKeyId),
  ];
  for (const change of checks) {
    db.prepare("UPDATE api_keys SET model = 'alpha', models = ? WHERE id = ?").run('["alpha","beta"]', privateKeyId);
    const person = new Person();
    db.prepare("INSERT INTO user_keys (user_id, api_key_id) VALUES (?, ?)").run(person.id, privateKeyId);
    const task = await person.create({ choice: { keyId: privateKeyId, model: "alpha", effort: "default" } });
    change(person);
    const before = calls().length;
    await tickTasks(due(task));
    assert.equal(calls().length, before);
    assert.equal(count("conversations", person.id), 0);
    assert.equal(count("usage_events", person.id), 0);
    assert.equal(runRows(task.id).length, 1);
    assert.equal(runRows(task.id)[0].status, "failed");
    assert.ok(runRows(task.id)[0].error);
    db.prepare("UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?").run(task.id);
  }
  db.prepare("UPDATE api_keys SET models = ? WHERE id = ?").run('["alpha","beta"]', privateKeyId);
});

test("repeated failed manual runs reach the request limit without adding more run records", async () => {
  const person = new Person();
  const task = await person.create();
  db.prepare("UPDATE users SET monthly_token_limit = 0 WHERE id = ?").run(person.id);
  const before = calls().length;
  for (let index = 0; index < 20; index++) {
    await person.run(task.id);
    await waitForTaskRuns();
  }
  const failed = await person.detail(task.id);
  assert.equal(failed.runs.length, 20);
  assert.ok(failed.runs.every((run) => run.status === "failed" && run.error && run.conversationId === null));
  for (let index = 0; index < 5; index++) {
    const rejected = await person.json("POST", `/tasks/${task.id}/run`, {});
    assert.equal(rejected.status, 429, JSON.stringify(rejected.body));
    await waitForTaskRuns();
    assert.equal(runRows(task.id).length, 20);
  }
  assert.equal((await person.detail(task.id)).nextRunAt, task.nextRunAt);
  assert.equal(count("conversations", person.id), 0);
  assert.equal(count("usage_events", person.id), 0);
  assert.equal(calls().length, before);
});

test("unattended tasks neither offer nor execute memory and MCP tools, even if a provider requests them", async () => {
  const person = new Person();
  const now = nowIso();
  db.prepare("INSERT INTO knowledge_bases (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Task notes', ?, ?)")
    .run(randomUUID(), person.id, now, now);
  db.prepare("INSERT INTO mcp_servers (name, url, tools, created_at) VALUES ('Task fixture', ?, ?, ?)")
    .run(`${service.url}/mcp`, JSON.stringify([
      { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "write", inputSchema: { type: "object" } },
    ]), now);
  requestedTools = ["memory", "task_fixture__read", "task_fixture__write"];
  const task = await person.create();
  const before = service.requests.length;
  await tickTasks(due(task));
  const run = (await person.detail(task.id)).runs[0];
  assert.equal(run.status, "failed", "A provider returning only undeclared actions cannot produce a successful reply");
  const saved = db.prepare("SELECT tool_defs, title_auto FROM conversations WHERE id = ?").get(run.conversationId!)!;
  assert.equal(saved.title_auto, 0);
  assert.deepEqual(JSON.parse(String(saved.tool_defs)).map((tool: { name: string }) => tool.name), ["search_knowledge"]);
  const sent = service.requests.slice(before);
  assert.equal(sent.length, 1, "Undeclared tool requests stop here without a retry, title, or MCP request");
  assert.ok(sent.every((request) => request.path === "/v1/chat/completions" && request.body.stream));
  assert.deepEqual(sent[0].body.tools.map((tool: { function: { name: string } }) => tool.function.name), ["search_knowledge"]);
  assert.equal(count("memories", person.id), 0);
});

test("an HTTP unattended field cannot change normal chat memory or conversation policies", async () => {
  const person = new Person();
  requestedTools = ["memory"];
  const before = calls().length;
  const response = await person.request("POST", "/chat", {
    text: "Remember I enjoy chemistry lessons", keyId, model: "alpha", effort: "default", unattended: true,
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(count("memories", person.id), 1);
  assert.ok(calls()[before].body.tools.some((tool: { function: { name: string } }) => tool.function.name === "memory"));
  const chat = db.prepare("SELECT id FROM conversations WHERE user_id = ?").get(person.id)!;
  requestedTools = [];
  const continued = await person.request("POST", "/chat", {
    text: "Continue with a short explanation", conversationId: chat.id, unattended: true,
  });
  assert.equal(continued.status, 200);
  await continued.text();
  assert.equal(count("conversations", person.id), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(chat.id)!.n, 4);
});

test("provider failures remain failures and never invoke a fallback model", async () => {
  const person = new Person();
  const task = await person.create();
  db.prepare("UPDATE api_keys SET fallback_key_id = ? WHERE id = ?").run(privateKeyId, keyId);
  failures.add("alpha");
  const before = calls().length;
  await tickTasks(due(task));
  const saved = await person.detail(task.id);
  assert.equal(saved.runs[0].status, "failed");
  assert.ok(saved.runs[0].error);
  assert.equal(calls().length - before, 1);
  assert.equal(count("usage_events", person.id), 0);
});

test("an active task cannot overlap or be deleted, can be paused without cancellation, and stops independently", async () => {
  const person = new Person();
  const task = await person.create();
  const before = calls().length;
  hold = true;
  await person.run(task.id);
  await until(() => held.length === 1);
  assert.equal((await person.json("POST", `/tasks/${task.id}/run`, {})).status, 409);
  assert.equal((await person.json("DELETE", `/tasks/${task.id}`)).status, 409);
  assert.equal((await person.json("PUT", `/tasks/${task.id}`, { name: "Changed", prompt: "Changed", choice: task.choice, schedule: daily })).status, 409);
  const tick = tickTasks(due(task));
  await person.json("PATCH", `/tasks/${task.id}`, { enabled: false });
  assert.equal((await person.detail(task.id)).runs[0].status, "running");
  assert.equal((await person.json("POST", `/tasks/${task.id}/stop`, {})).status, 200);
  hold = false;
  held.splice(0).forEach((release) => release());
  await tick;
  await waitForTaskRuns();
  const saved = await person.detail(task.id);
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].status, "stopped");
  assert.equal(calls().length - before, 1);
  assert.equal((await person.json("DELETE", `/tasks/${task.id}`)).status, 200);
});

test("deleting a completed task preserves its generated conversations and usage records", async () => {
  const person = new Person();
  const task = await person.create();
  await person.run(task.id);
  await waitForTaskRuns();
  const conversationId = (await person.detail(task.id)).runs[0].conversationId;
  assert.ok(conversationId);
  assert.equal((await person.json("DELETE", `/tasks/${task.id}`)).status, 200);
  assert.ok(db.prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?").get(conversationId, person.id));
  assert.equal(count("usage_events", person.id), 1);
  assert.equal(runRows(task.id).length, 0);
});

/** Mail sent while `work` runs: without SMTP, development mail goes to the server log. */
async function mailDuring(work: () => Promise<void>): Promise<string[]> {
  const sent: string[] = [];
  const log = mock.method(console, "log", (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[mail] to ")) sent.push(line);
  });
  try { await work(); await new Promise((resolve) => setImmediate(resolve)); } finally { log.mock.restore(); }
  return sent;
}
const emailOf = (person: Person) => (db.prepare("SELECT email FROM users WHERE id = ?").get(person.id) as { email: string }).email;

test("a task emails its owner after scheduled runs only when asked, and never for Run now", async () => {
  const person = new Person();
  assert.deepEqual((await person.json("GET", "/tasks/email")).body, { available: true, address: emailOf(person) });
  const quiet = await person.create();
  assert.equal(quiet.email, false);
  assert.deepEqual(await mailDuring(() => tickTasks(due(quiet))), []);

  const task = await person.create({ name: "Lesson digest", email: true });
  assert.equal(task.email, true);
  const sent = await mailDuring(() => tickTasks(due(task)));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith(`[mail] to ${emailOf(person)}: Your scheduled task Lesson digest has run`), sent[0]);
  assert.match(sent[0], /Scheduled reply from alpha/);
  assert.match(sent[0], /turn this off on the task's page/);

  assert.deepEqual(await mailDuring(async () => { await person.run(task.id); await waitForTaskRuns(); }), []);

  const later = await person.create({ name: "Later digest", email: true });
  const off = await person.json("PUT", `/tasks/${later.id}`, { name: later.name, prompt: later.prompt, choice: later.choice, schedule: daily, email: false });
  assert.equal(off.body.email, false);
  assert.deepEqual(await mailDuring(() => tickTasks(due(off.body))), []);
});

test("an emailing task says why a scheduled run failed or was cut off by a restart", async () => {
  const person = new Person();
  const task = await person.create({ name: "Failing digest", email: true });
  failures.add("alpha");
  const failed = await mailDuring(() => tickTasks(due(task)));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /Your scheduled task Failing digest didn't finish/);
  assert.match(failed[0], /It stopped with this message: /);
  assert.doesNotMatch(failed[0], /Scheduled reply/);

  const past = new Date(Date.now() - DAY).toISOString();
  db.prepare("INSERT INTO scheduled_runs (id, task_id, trigger, scheduled_for, started_at, status) VALUES (?, ?, 'scheduled', ?, ?, 'running')")
    .run(randomUUID(), task.id, past, past);
  const restarted = await mailDuring(async () => recoverTaskRuns());
  assert.equal(restarted.length, 1);
  assert.match(restarted[0], /The server restarted during this run/);
});
