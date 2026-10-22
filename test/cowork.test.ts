// Cowork jobs: claimed turns in one chat, limits, stopping, restarts and approvals while away,
// against a throwaway database, a local provider and a local MCP server only.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { Hono } from "hono";
import { sameOriginGuard, sessionMiddleware, type AppEnv } from "../server/auth.ts";
import { coworkRoutes, recoverCowork, tickCowork, waitForCowork } from "../server/cowork.ts";
import { encryptSecret, hashToken } from "../server/crypto.ts";
import { db, nowIso } from "../server/db.ts";
import { forget, listTools } from "../server/mcp.ts";
import { chatRoutes } from "../server/routes/chat.ts";
import { chunk, completionStream, json, mockServer, usageChunk, type MockServer, type Received, type Reply } from "./helpers/mock-server.ts";
import { mcpServer } from "./helpers/mcp-server.ts";

const app = new Hono<AppEnv>();
app.use("*", sameOriginGuard, sessionMiddleware);
app.route("/api", coworkRoutes);
app.route("/api", chatRoutes);

/** What the model does on one request: call tools (by name, or picked from what it's offered), or write. */
type Move = { tools?: { name: string | ((offered: string[]) => string); input?: Record<string, unknown> }[]; text?: string; tokens?: number; wait?: number };
let plan: Move[] = [];
/** What it does once the plan runs out. */
let fallback: Move = { text: "All done" };
let hold = false;
const held: (() => void)[] = [];
let service: MockServer;
let mcp: Awaited<ReturnType<typeof mcpServer>>;
let keyId: number;
let serverId: number;
const DAY = 86_400_000;
const LIMITS = { steps: 20, minutes: 15, spend: null };

const offeredNames = (req: Received): string[] => (req.body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);

before(async () => {
  service = await mockServer(async (req) => {
    if (!req.body.stream) return json({ choices: [{ message: { content: "A title" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const move = plan.shift() ?? fallback;
    if (move.wait) await new Promise((resolve) => setTimeout(resolve, move.wait));
    const usage = usageChunk({ prompt_tokens: move.tokens ?? 10, completion_tokens: 5, total_tokens: (move.tokens ?? 10) + 5 });
    let reply: Reply;
    if (move.tools && req.body.tool_choice !== "none") {
      const offered = offeredNames(req);
      reply = completionStream([
        chunk({ tool_calls: move.tools.map((tool, index) => ({
          index, id: `call_${randomUUID()}`, type: "function",
          function: { name: typeof tool.name === "function" ? tool.name(offered) : tool.name, arguments: JSON.stringify(tool.input ?? {}) },
        })) }),
        chunk({}, "tool_calls"),
        usage,
      ]);
    } else {
      reply = completionStream([chunk({ content: move.text ?? "Wrote it up" }), chunk({}, "stop"), usage]);
    }
    return hold ? new Promise<Reply>((resolve) => held.push(() => resolve(reply))) : reply;
  });
  keyId = Number(db.prepare(
    `INSERT INTO api_keys (label, provider, model, effort, encrypted_key, last4, shared, endpoint, models, code_execution, created_at)
     VALUES ('Workers', 'custom', 'alpha', 'default', ?, 'test', 1, ?, '["alpha"]', 1, ?)`,
  ).run(encryptSecret("sk-local-cowork-test"), JSON.stringify({
    baseUrl: `${service.url}/v1`, images: false, models: [{ id: "alpha", input: 1, output: 2 }],
  }), nowIso()).lastInsertRowid);
  mcp = await mcpServer();
  serverId = Number(db.prepare("INSERT INTO mcp_servers (name, url, enabled, shared, tools, created_at) VALUES ('Notes', ?, 1, 1, ?, ?)")
    .run(mcp.url, JSON.stringify(await listTools(mcp.url, {})), nowIso()).lastInsertRowid);
});

afterEach(async () => {
  hold = false;
  held.splice(0).forEach((release) => release());
  await waitForCowork();
  plan = [];
  fallback = { text: "All done" };
});

after(async () => {
  held.splice(0).forEach((release) => release());
  forget(serverId);
  await mcp.close();
  await service.close();
});

class Person {
  id: number;
  token = randomUUID();
  constructor() {
    this.id = Number(db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, 'test', ?)")
      .run(`${randomUUID()}@example.com`, nowIso()).lastInsertRowid);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(this.token), this.id, new Date(Date.now() + DAY).toISOString(), nowIso());
  }
  async json(method: string, path: string, body?: unknown) {
    const response = await app.request(`http://parley.test/api${path}`, {
      method,
      headers: { cookie: `sid=${this.token}`, origin: "http://parley.test", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async start(extra: Record<string, unknown> = {}) {
    const response = await this.json("POST", "/cowork", {
      goal: "Write up the week's lesson plans", choice: { keyId, model: "alpha", effort: "default" }, limits: LIMITS, ...extra,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async job(id: string) {
    const response = await this.json("GET", `/cowork/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
}

const streamed = () => service.requests.filter((request) => request.body?.stream === true);
const messagesOf = (conversationId: string) =>
  db.prepare("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId) as { role: string; text: string }[];
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the job");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a job works through several turns in one chat, with its own tools and a step record", async () => {
  const person = new Person();
  plan = [
    { tools: [{ name: "update_progress", input: { steps: [{ text: "Draft Monday", status: "doing" }, { text: "Draft Tuesday", status: "todo" }] } }, { name: "save_file", input: { name: "monday.md", content: "# Monday" } }] },
    { text: "Monday is drafted" },
    { tools: [{ name: "finish_job" }] },
    { text: "Here are the plans, in monday.md" },
  ];
  const from = streamed().length;
  const started = await person.start({ limits: undefined });
  assert.equal(started.title, "Write up the week's lesson plans");
  await waitForCowork();
  const job = await person.job(started.id);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.limit, null);
  const offered = offeredNames(streamed()[from]);
  assert.ok(offered.includes("update_progress") && offered.includes("finish_job") && offered.includes("save_file"));
  assert.ok(!offered.includes("memory"), "a job never writes memory");
  // The goal, the first turn's update, then an automatic carry-on and the result, all in one chat.
  assert.deepEqual(messagesOf(job.conversationId).map((m) => [m.role, m.text]), [
    ["user", "Write up the week's lesson plans"],
    ["assistant", "Monday is drafted"],
    ["user", "Carry on with the job"],
    ["assistant", "Here are the plans, in monday.md"],
  ]);
  assert.deepEqual(job.steps.map((s: { kind: string; text: string }) => [s.kind, s.text]), [
    ["start", "Started with alpha"], ["tool", "Saved monday.md"], ["reply", "Monday is drafted"],
    ["reply", "Here are the plans, in monday.md"], ["end", "Finished"],
  ]);
  assert.deepEqual(job.progress, [{ text: "Draft Monday", status: "doing" }, { text: "Draft Tuesday", status: "todo" }]);
  assert.deepEqual(job.files.map((f: { name: string }) => f.name), ["monday.md"]);
  // Two turns and one tool call; the job's own checklist and finish_job aren't steps.
  assert.equal(job.used.steps, 3);
  assert.ok(job.used.spent > 0);
  const list = (await person.json("GET", "/cowork")).body.jobs;
  assert.equal(list[0].id, job.id);
  assert.equal(list[0].lastStep, "Finished");
  assert.deepEqual(job.limits, { steps: 50, minutes: 60, spend: 2 }, "a job starts with the usual limits");
});

test("a turn that uses no tools ends the job, and the system note tells the model how to work", async () => {
  const person = new Person();
  const from = streamed().length;
  const job = await person.start();
  await waitForCowork();
  const done = await person.job(job.id);
  assert.equal(done.status, "done");
  assert.equal(streamed().length - from, 1);
  const system = streamed()[from].body.messages[0];
  assert.equal(system.role, "system");
  assert.match(system.content, /finish_job/);
});

test("the step limit turns tools away, lets the model write up, and says which limit stopped it", async () => {
  const person = new Person();
  fallback = { tools: [{ name: "save_file", input: { name: "notes.md", content: "More" } }] };
  const job = await person.start({ limits: { ...LIMITS, steps: 20 } });
  await waitForCowork();
  const stopped = await person.job(job.id);
  assert.equal(stopped.status, "limit");
  assert.equal(stopped.limit, "steps");
  assert.equal(stopped.steps.at(-1).text, "Stopped after using its 20 steps");
  assert.ok(stopped.used.steps <= 20, `used ${stopped.used.steps}`);
  // A model that keeps calling tools after it's told to stop gets a few refusals, then is cut off.
  // (Each request carries the whole history, so a refusal is counted once by its call.)
  const refusals = new Set(service.requests.flatMap((r) => r.body?.messages ?? [])
    .filter((m: { role: string; content: string }) => m.role === "tool" && /used all its steps/.test(m.content))
    .map((m: { tool_call_id: string }) => m.tool_call_id));
  assert.ok(refusals.size >= 1 && refusals.size <= 4, `${refusals.size} refusals`);
});

test("the spending cap stops a job between turns", async () => {
  const person = new Person();
  // A million prompt tokens at $1 a million is about $1 a turn, over a $0.50 cap.
  plan = [{ tools: [{ name: "save_file", input: { name: "a.md", content: "A" } }], tokens: 1_000_000 }];
  const from = streamed().length;
  const job = await person.start({ limits: { ...LIMITS, spend: 0.5 } });
  await waitForCowork();
  const stopped = await person.job(job.id);
  assert.equal(stopped.status, "limit");
  assert.equal(stopped.limit, "spend");
  assert.equal(stopped.steps.at(-1).text, "Stopped at its spending cap of $0.50");
  assert.equal(streamed().length - from, 2, "no turn starts after the cap is reached");
});

test("the time limit turns tools away once the working time is up", async () => {
  const person = new Person();
  const job = await person.start();
  await waitForCowork();
  // Have it carry on with 30ms of its 15 minutes left, and slow tool calls.
  fallback = { tools: [{ name: "save_file", input: { name: "slow.md", content: "Slow" } }], wait: 80 };
  db.prepare(`UPDATE cowork_jobs SET status = 'queued', worked_ms = ?, base_ms = 0, base_steps = steps, base_spent = spent WHERE id = ?`)
    .run(15 * 60_000 - 30, job.id);
  tickCowork();
  await waitForCowork();
  const stopped = await person.job(job.id);
  assert.equal(stopped.status, "limit", JSON.stringify(stopped.steps));
  assert.equal(stopped.limit, "time");
  assert.equal(stopped.steps.at(-1).text, "Stopped after 15 minutes of work");
  assert.ok(!stopped.steps.some((s: { text: string }) => s.text === "Saved slow.md"), "no tool runs after the time is up");
});

test("a job can't start past the monthly allowance", async () => {
  const person = new Person();
  db.prepare("UPDATE users SET spend_limit_mode = 'own', monthly_spend_limit = 0 WHERE id = ?").run(person.id);
  const response = await person.json("POST", "/cowork", { goal: "Anything", choice: { keyId, model: "alpha", effort: "default" }, limits: LIMITS });
  assert.equal(response.status, 429);
  assert.match(response.body.error, /spending limit/);
});

test("limits and models are checked before a job is kept", async () => {
  const person = new Person();
  for (const body of [
    { goal: "", choice: { keyId, model: "alpha", effort: "default" }, limits: LIMITS },
    { goal: "Go", choice: { keyId, model: "missing", effort: "default" }, limits: LIMITS },
    { goal: "Go", choice: { keyId, model: "alpha", effort: "default" }, limits: { ...LIMITS, steps: 1000 } },
    { goal: "Go", choice: { keyId, model: "alpha", effort: "default" }, limits: { ...LIMITS, spend: 99 } },
  ]) {
    assert.equal((await person.json("POST", "/cowork", body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await person.json("GET", "/cowork")).body.jobs, []);
});

test("stopping a job ends its turn and says the person stopped it", async () => {
  const person = new Person();
  hold = true;
  const job = await person.start();
  await until(() => held.length > 0);
  assert.equal((await person.job(job.id)).status, "running");
  assert.equal((await person.json("POST", `/cowork/${job.id}/stop`)).status, 200);
  await waitForCowork();
  const stopped = await person.job(job.id);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.steps.at(-1).text, "You stopped it");
});

test("stopping a job that waits for an OK drops the question without logging the call", async () => {
  const person = new Person();
  plan = [{ tools: [{ name: (offered) => offered.find((name) => name.endsWith("add_note"))!, input: { text: "Buy chalk" } }] }];
  const job = await person.start();
  await until(async () => (await person.job(job.id)).status === "waiting");
  assert.equal((await person.json("POST", `/cowork/${job.id}/stop`)).status, 200);
  await waitForCowork();
  const stopped = await person.job(job.id);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.asks, []);
  assert.ok(!stopped.steps.some((s: { kind: string }) => s.kind === "tool"), JSON.stringify(stopped.steps));
  // Carry on picks it up again in the same chat.
  plan = [{ text: "Nothing else to do" }];
  assert.equal((await person.json("POST", `/cowork/${job.id}/continue`)).status, 200);
  await waitForCowork();
  const resumed = await person.job(job.id);
  assert.equal(resumed.status, "done");
  assert.equal(resumed.conversationId, stopped.conversationId);
  assert.equal(resumed.used.steps, 1, "limits count again from the carry-on");
});

test("after a restart, a job caught mid-turn waits for the person and one between turns resumes", async () => {
  const person = new Person();
  const finished = await person.start();
  await waitForCowork();
  const done = await person.job(finished.id);
  // Mid-turn: a carry-on message was sent and its reply never came back.
  const head = Number(db.prepare("INSERT INTO messages (conversation_id, parent_id, role, text, created_at) VALUES (?, (SELECT head_id FROM conversations WHERE id = ?), 'user', 'Carry on with the job', ?)")
    .run(done.conversationId, done.conversationId, nowIso()).lastInsertRowid);
  db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(head, done.conversationId);
  db.prepare("UPDATE cowork_jobs SET status = 'running', turn_open = 1, finished_at = NULL WHERE id = ?").run(finished.id);
  // Between turns: nothing was in flight.
  const between = await person.start();
  await waitForCowork();
  db.prepare("UPDATE cowork_jobs SET status = 'running', turn_open = 0, finished_at = NULL WHERE id = ?").run(between.id);

  const from = streamed().length;
  recoverCowork();
  assert.equal(streamed().length, from, "recovery never calls a provider");
  const interrupted = await person.job(finished.id);
  assert.equal(interrupted.status, "interrupted");
  assert.match(interrupted.error, /restarted/);
  assert.equal((await person.job(between.id)).status, "queued");

  tickCowork();
  await waitForCowork();
  assert.equal(streamed().length - from, 1, "only the job that was between turns carries on by itself");
  assert.equal((await person.job(between.id)).status, "done");
  assert.equal((await person.job(finished.id)).status, "interrupted");

  // Carry on answers the cut-off message again rather than adding another.
  const before = messagesOf(done.conversationId).length;
  assert.equal((await person.json("POST", `/cowork/${finished.id}/continue`)).status, 200);
  await waitForCowork();
  const after = messagesOf(done.conversationId);
  assert.equal(after.length, before + 1);
  assert.deepEqual(after.slice(-2).map((m) => m.role), ["user", "assistant"]);
  assert.equal((await person.job(finished.id)).status, "done");
});

test("only the owner sees or controls a job", async () => {
  const owner = new Person();
  const other = new Person();
  assert.equal((await app.request("http://parley.test/api/cowork")).status, 401);
  const job = await owner.start();
  await waitForCowork();
  assert.deepEqual((await other.json("GET", "/cowork")).body.jobs, []);
  for (const [method, path, body] of [
    ["GET", `/cowork/${job.id}`], ["PATCH", `/cowork/${job.id}`, { email: true }], ["POST", `/cowork/${job.id}/stop`],
    ["POST", `/cowork/${job.id}/continue`], ["POST", `/cowork/${job.id}/asks/x`, { allow: true }], ["DELETE", `/cowork/${job.id}`],
  ] as const) {
    assert.equal((await other.json(method, path, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await owner.json("DELETE", `/cowork/${job.id}`)).status, 200);
  assert.equal((await owner.json("GET", `/cowork/${job.id}`)).status, 404);
});

test("a tool that needs the person's OK holds the job until they answer on its page", async () => {
  const person = new Person();
  const addNote = (offered: string[]) => offered.find((name) => name.endsWith("add_note"))!;
  plan = [{ tools: [{ name: addNote, input: { text: "Buy chalk" } }] }, { text: "Added the note" }, { tools: [{ name: "finish_job" }] }, { text: "Done" }];
  const calls = mcp.calls.length;
  const job = await person.start();
  await until(async () => (await person.job(job.id)).status === "waiting");
  const waiting = await person.job(job.id);
  assert.equal(waiting.asks.length, 1);
  assert.match(waiting.asks[0].question, /add_note on Notes/);
  assert.equal(mcp.calls.length, calls, "nothing reaches the server before the OK");
  // Waiting time isn't working time.
  const workedBefore = waiting.used.ms;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok((await person.job(job.id)).used.ms - workedBefore < 40);
  // The chat shows the same question.
  assert.equal((await person.json("GET", `/conversations/${waiting.conversationId}`)).body.asks[0].id, waiting.asks[0].id);
  assert.equal((await new Person().json("POST", `/cowork/${job.id}/asks/${waiting.asks[0].id}`, { allow: true })).status, 404);
  assert.equal((await person.json("POST", `/cowork/${job.id}/asks/${waiting.asks[0].id}`, { allow: true })).status, 200);
  await waitForCowork();
  const done = await person.job(job.id);
  assert.equal(done.status, "done");
  assert.equal(mcp.calls.length, calls + 1);
  const texts = done.steps.map((s: { text: string }) => s.text);
  assert.ok(texts.includes("Waiting for your OK: Use add_note on Notes?"), texts.join("\n"));
  assert.ok(texts.includes("You allowed it"));
  assert.ok(texts.includes("Used add_note on Notes"));
});

test("a question turned down lets the job carry on without the tool", async () => {
  const person = new Person();
  const addNote = (offered: string[]) => offered.find((name) => name.endsWith("add_note"))!;
  plan = [{ tools: [{ name: addNote, input: { text: "Buy chalk" } }] }, { text: "Skipped the note" }, { text: "Nothing more to do" }];
  const calls = mcp.calls.length;
  const job = await person.start();
  await until(async () => (await person.job(job.id)).status === "waiting");
  const waiting = await person.job(job.id);
  assert.equal((await person.json("POST", `/cowork/${job.id}/asks/${waiting.asks[0].id}`, { allow: false })).status, 200);
  await waitForCowork();
  const done = await person.job(job.id);
  assert.equal(done.status, "done");
  assert.equal(mcp.calls.length, calls);
  assert.ok(done.steps.some((s: { text: string }) => s.text === "You turned it down"));
  assert.ok(!done.steps.some((s: { kind: string }) => s.kind === "tool"), "a call turned down isn't a step");
});

test("two jobs work for a person at once, and a third waits its turn", async () => {
  const person = new Person();
  hold = true;
  const jobs = [await person.start(), await person.start(), await person.start()];
  await until(() => held.length === 2);
  const statuses = await Promise.all(jobs.map(async (job) => (await person.job(job.id)).status));
  assert.deepEqual(statuses, ["running", "running", "queued"]);
  hold = false;
  held.splice(0).forEach((release) => release());
  await waitForCowork();
  tickCowork();
  await waitForCowork();
  assert.deepEqual(await Promise.all(jobs.map(async (job) => (await person.job(job.id)).status)), ["done", "done", "done"]);
});

test("a message sent while it works ends the step and becomes its next turn", async () => {
  const person = new Person();
  hold = true;
  plan = [{ tools: [{ name: "save_file", input: { name: "draft.md", content: "Draft" } }] }, { text: "Drafted, carrying on" }, { text: "Switched to Friday" }];
  const job = await person.start();
  await until(() => held.length > 0);
  const sent = await person.json("POST", `/cowork/${job.id}/messages`, { text: "Make it Friday instead" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.inbox, ["Make it Friday instead"]);
  hold = false;
  held.splice(0).forEach((release) => release());
  await waitForCowork();
  const done = await person.job(job.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.inbox, []);
  // The tool result told the model to wrap up, and the next turn was the person's message.
  const toolResults = service.requests.flatMap((r) => r.body?.messages ?? []).filter((m: { role: string }) => m.role === "tool");
  assert.ok(toolResults.some((m: { content: string }) => /just sent you a message/.test(m.content)));
  assert.deepEqual(messagesOf(done.conversationId).map((m) => [m.role, m.text]), [
    ["user", "Write up the week's lesson plans"],
    ["assistant", "Drafted, carrying on"],
    ["user", "Make it Friday instead"],
    ["assistant", "Switched to Friday"],
  ]);
  assert.ok(done.steps.some((s: { kind: string; text: string }) => s.kind === "message" && s.text === "Make it Friday instead"));
});

test("a message to a finished job has it carry on with that instruction", async () => {
  const person = new Person();
  const job = await person.start();
  await waitForCowork();
  plan = [{ text: "Added a summary" }];
  const sent = await person.json("POST", `/cowork/${job.id}/messages`, { text: "Add a short summary too" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await waitForCowork();
  const done = await person.job(job.id);
  assert.equal(done.status, "done");
  assert.deepEqual(messagesOf(done.conversationId).slice(-2).map((m) => m.text), ["Add a short summary too", "Added a summary"]);
  assert.equal((await new Person().json("POST", `/cowork/${job.id}/messages`, { text: "Hi" })).status, 404);
  assert.equal((await person.json("POST", `/cowork/${job.id}/messages`, { text: " " })).status, 400);
});

test("limits can be changed on a job's page, from the options only", async () => {
  const person = new Person();
  const job = await person.start();
  await waitForCowork();
  const changed = await person.json("PATCH", `/cowork/${job.id}`, { limits: { steps: 100, minutes: 240, spend: null } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.limits, { steps: 100, minutes: 240, spend: null });
  assert.equal((await person.json("PATCH", `/cowork/${job.id}`, { limits: { steps: 7, minutes: 60, spend: 2 } })).status, 400);
  assert.equal((await person.json("PATCH", `/cowork/${job.id}`, { email: true })).body.email, true);
});
