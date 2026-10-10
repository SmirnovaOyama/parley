// The API end to end: the real server (server/index.ts) in a child process, on a temporary
// database with a throwaway secret, talking to a mock "another service" for its replies.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { Agent, fetch as undiciFetch } from "undici";
import { mcpServer } from "./helpers/mcp-server.ts";
import { chunk, completionStream, json, mockServer, modelList, usageChunk, type MockServer } from "./helpers/mock-server.ts";
import { zipOf } from "./helpers/zip.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "parley-api-"));
const DATABASE_PATH = join(dir, "chat.db");

/** The server, and everything it has printed (shown when it doesn't start). */
let server: { child: ChildProcess; url: string; log: () => string };
let service: MockServer;

async function startServer() {
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: ROOT,
    // Only what the server needs, so nothing in the shell (or a .env) changes what's tested.
    env: { PATH: process.env.PATH, NODE_ENV: "test", PORT: "0", DATABASE_PATH, KEY_ENCRYPTION_SECRET: randomBytes(24).toString("hex") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The server didn't start:\n${log}`)), 15_000);
    const read = (data: Buffer) => {
      log += data;
      const port = log.match(/listening on http:\/\/localhost:(\d+)/)?.[1];
      if (port) {
        clearTimeout(timer);
        resolve(Number(port));
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The server stopped (exit code ${code}):\n${log}`));
    });
  });
  return { child, url: `http://127.0.0.1:${port}`, log: () => log };
}

/** Someone using the site: keeps their session cookie between requests. */
class Visitor {
  cookie = "";

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const raw = body instanceof Uint8Array;
    const res = await fetch(server.url + path, {
      method,
      headers: {
        ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const sid = res.headers.getSetCookie().find((c) => c.startsWith("sid="));
    if (sid) this.cookie = sid.split(";")[0];
    return res;
  }

  async json(method: string, path: string, body?: unknown) {
    const res = await this.request(method, path, body);
    return { status: res.status, body: (await res.json()) as any };
  }

  /** Adds a file to the message being written, as the browser does. */
  async upload(name: string, bytes: string | Buffer) {
    const res = await this.request("PUT", "/api/uploads", Buffer.from(bytes), { "x-file-name": encodeURIComponent(name) });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { attachment: { id: string; kind: string } }).attachment;
  }

  /** Sends a message and reads the reply's events to the end of the stream. */
  async chat(body: Record<string, unknown>) {
    const res = await this.request("POST", "/api/chat", body);
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    return parseEvents(await res.text());
  }
}

/** Server-sent events as { event, data } with the data parsed. */
function parseEvents(text: string): { event: string; data: any }[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      return { event, data: data ? JSON.parse(data) : null };
    });
}

/** Reads a reply's events as they arrive, handing each to `on` (which may act on it, say answer a question) before reading on. */
async function readEvents(res: Response, on: (e: { event: string; data: any }) => Promise<void> | void) {
  // (Its text is read only on a failure: the stream may be waiting on what `on` does.)
  if (res.status !== 200) assert.fail(await res.text());
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { event: string; data: any }[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const [event] = parseEvents(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      if (!event) continue;
      events.push(event);
      await on(event);
    }
  }
  return events;
}

/** The service's reply to a chat message: reasoning, two pieces of answer, then usage with a cache hit. */
const REPLY = [
  chunk({ role: "assistant", content: "" }),
  chunk({ reasoning_content: "Thinking it over." }),
  chunk({ content: "Hi" }),
  chunk({ content: " there!" }),
  chunk({}, "stop"),
  usageChunk({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } }),
];
/** A message that has the service ask for the memory tool before it answers. */
const REMEMBER = "Remember that I teach chemistry";
const REMEMBER_CALL = [
  chunk({ role: "assistant", content: "" }),
  chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "memory", arguments: '{"action":"save","text":"Teaches chemistry"}' } }] }),
  chunk({}, "tool_calls"),
];
const TITLE = {
  id: "chatcmpl-title",
  object: "chat.completion",
  created: 0,
  model: "mock-model",
  choices: [{ index: 0, message: { role: "assistant", content: "Friendly greeting" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
};

before(async () => {
  service = await mockServer((req) => {
    if (req.method === "GET" && req.path === "/v1/models") return modelList(["mock-model"]);
    if (req.method === "POST" && req.path === "/v1/chat/completions") {
      if (!req.body.stream) return json(TITLE);
      const last = req.body.messages.at(-1);
      return completionStream(typeof last.content === "string" && last.content.endsWith(REMEMBER) ? REMEMBER_CALL : REPLY);
    }
    throw new Error(`Unexpected ${req.method} ${req.path}`);
  });
  server = await startServer();
});

after(async () => {
  if (server && server.child.exitCode === null) {
    server.child.kill();
    await once(server.child, "exit");
  }
  await service?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("api", () => {
  const admin = new Visitor();
  const member = new Visitor();
  let keyId: number;
  let conversationId: string;

  test("says it's healthy without an account", async () => {
    assert.deepEqual(await new Visitor().json("GET", "/api/health"), { status: 200, body: { ok: true } });
  });

  test("the first account becomes the admin", async () => {
    assert.deepEqual((await admin.json("GET", "/api/auth/state")).body, { needsSetup: true, allowSignup: true });
    const signup = await admin.json("POST", "/api/auth/signup", { email: "Admin@Example.com", password: "correct horse" });
    assert.equal(signup.status, 200);
    assert.ok(admin.cookie, "signing up starts a session");
    const me = await admin.json("GET", "/api/auth/me");
    assert.deepEqual(me.body.user, { id: me.body.user.id, email: "admin@example.com", role: "admin" });
  });

  test("a second account doesn't", async () => {
    assert.equal((await member.json("POST", "/api/auth/signup", { email: "member@example.com", password: "battery staple" })).status, 200);
    assert.equal((await member.json("GET", "/api/auth/me")).body.user.role, "user");
    assert.equal((await member.json("GET", "/api/auth/state")).body.needsSetup, false);
  });

  test("only admins reach /api/admin", async () => {
    assert.deepEqual(await new Visitor().json("GET", "/api/admin/keys"), { status: 401, body: { error: "Sign in to continue" } });
    for (const path of ["/api/admin/keys", "/api/admin/users", "/api/admin/settings", "/api/admin/usage", "/api/admin/overview", "/api/admin/conversations", "/api/admin/audit"]) {
      assert.deepEqual(await member.json("GET", path), { status: 403, body: { error: "Admins only" } }, path);
    }
    assert.equal((await member.json("POST", "/api/admin/keys", { label: "Mine", provider: "custom" })).status, 403);
    assert.equal((await member.json("PATCH", "/api/admin/settings", { allowSignup: false })).status, 403);
    assert.equal((await member.json("PATCH", "/api/admin/users/1", { role: "user" })).status, 403);
    assert.equal((await admin.json("GET", "/api/admin/keys")).status, 200);
    assert.equal((await admin.json("GET", "/api/admin/settings")).body.settings.allowSignup, true);
  });

  test("an admin adds a key on another service, checked against its model list", async () => {
    const draft = { label: "Mock service", provider: "custom", effort: "default", apiKey: "sk-mock-0001" };
    const wrong = await admin.json("POST", "/api/admin/keys", {
      ...draft,
      model: "missing-model",
      endpoint: { baseUrl: `${service.url}/v1`, models: [{ id: "missing-model" }] },
    });
    assert.deepEqual(wrong, { status: 400, body: { error: "This key can't use missing-model. It offers mock-model" } });

    const added = await admin.json("POST", "/api/admin/keys", {
      ...draft,
      model: "mock-model",
      endpoint: { baseUrl: `${service.url}/v1/`, models: [{ id: "mock-model", input: "1", output: 2 }] },
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    keyId = added.body.id;
    const check = service.requests.at(-1)!;
    assert.equal(`${check.method} ${check.path}`, "GET /v1/models");
    assert.equal(check.headers.authorization, "Bearer sk-mock-0001");

    const [key] = (await admin.json("GET", "/api/admin/keys")).body.keys;
    assert.equal(key.id, keyId);
    assert.equal(key.providerLabel, new URL(service.url).host);
    assert.equal(key.isDefault, true);
    assert.equal(key.last4, "0001");
    assert.deepEqual(key.models, ["mock-model"]);
    assert.deepEqual(key.endpoint, { baseUrl: `${service.url}/v1`, models: [{ id: "mock-model", input: 1, output: 2 }], images: false });

    // Everyone can pick it: the first key is the site's default.
    const models = (await member.json("GET", "/api/models")).body;
    assert.deepEqual(models.start, { keyId, model: "mock-model", effort: "default" });
    assert.deepEqual(models.choices, [
      // Another service's model has no known context window.
      { keyId, model: "mock-model", label: "mock-model", efforts: [{ id: "default", label: "Default" }], defaultEffort: "default", reads: ["text"], context: null },
    ]);
  });

  test("a chat streams its reply as events and gets a title", async () => {
    const before = service.requests.length;
    const events = await admin.chat({ text: "Hello there" });
    assert.deepEqual(
      events.map((e) => e.event),
      ["meta", "status", "thinking", "status", "delta", "delta", "done", "title"],
    );
    const [meta, thinking, writing] = [events[0].data, events[1].data, events[3].data];
    conversationId = meta.conversationId;
    assert.deepEqual(meta, { conversationId, title: "Hello there", created: true, userMessageId: meta.userMessageId, keyId, model: "mock-model", modelId: "mock-model", effort: "default" });
    assert.deepEqual([thinking, writing], [{ status: "thinking" }, { status: "writing" }]);
    assert.equal(events[2].data.text, "Thinking it over.");
    assert.deepEqual(events.filter((e) => e.event === "delta").map((e) => e.data.text), ["Hi", " there!"]);
    const done = events[6].data.message;
    assert.equal(done.text, "Hi there!");
    assert.equal(done.status, "ok");
    assert.equal(done.model, "mock-model");
    assert.equal(done.thinking, "Thinking it over.");
    assert.equal(done.parentId, meta.userMessageId);
    assert.deepEqual(events[7].data, { title: "Friendly greeting" });

    // What the service was sent: the conversation streamed, then a one-off request for the title.
    const [reply, title] = service.requests.slice(before);
    assert.equal(reply.headers.authorization, "Bearer sk-mock-0001");
    assert.equal(reply.body.model, "mock-model");
    assert.equal(reply.body.stream, true);
    assert.equal(reply.body.messages[0].role, "system");
    assert.deepEqual(reply.body.messages.slice(1), [{ role: "user", content: "Hello there" }]);
    assert.equal(title.body.stream, undefined);
    assert.match(title.body.messages[1].content, /<conversation>\nPerson: Hello there\n\nAssistant: Hi there!\n<\/conversation>/);

    const chat = (await admin.json("GET", `/api/conversations/${conversationId}`)).body;
    assert.equal(chat.conversation.title, "Friendly greeting");
    assert.deepEqual(chat.messages.map((m: { role: string; text: string }) => [m.role, m.text]), [["user", "Hello there"], ["assistant", "Hi there!"]]);
  });

  test("the reply and its title are costed at the key's prices", () => {
    const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
    const rows = db
      .prepare("SELECT api_key_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd FROM usage_events ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    db.close();
    const near = (actual: unknown, expected: number) => assert.ok(Math.abs(Number(actual) - expected) < 1e-12, `${actual} is not ${expected}`);
    assert.equal(rows.length, 2);
    // 1,000 fresh input tokens and 200 cached at $1 a million (cache reads at the input price), 300 out at $2.
    assert.deepEqual({ ...rows[0], cost_usd: 0 }, { api_key_id: keyId, provider: "custom", model: "mock-model", input_tokens: 1000, output_tokens: 300, cache_read_tokens: 200, cache_write_tokens: 0, cost_usd: 0 });
    near(rows[0].cost_usd, (1000 * 1 + 300 * 2 + 200 * 1) / 1_000_000);
    // Naming the chat counts too.
    assert.deepEqual([rows[1].input_tokens, rows[1].output_tokens], [50, 5]);
    near(rows[1].cost_usd, (50 * 1 + 5 * 2) / 1_000_000);
  });

  test("a text file goes in with the message", async () => {
    const before = service.requests.length;
    const file = await admin.upload("shopping list.txt", "Milk\nEggs\n");
    assert.equal(file.kind, "text");
    const events = await admin.chat({ conversationId, text: "What's on it?", attachments: [file.id] });
    // The second exchange keeps the title.
    assert.deepEqual(events.map((e) => e.event).slice(-2), ["delta", "done"]);
    assert.equal(service.requests.length, before + 1);
    const sent = service.requests[before].body.messages;
    assert.deepEqual(sent.slice(1), [
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: '<file name="shopping list.txt">\nMilk\nEggs\n\n</file>\n\nWhat\'s on it?' },
    ]);
  });

  test("a PDF to a model that reads text only is turned away", async () => {
    const before = service.requests.length;
    const file = await admin.upload("report.pdf", "%PDF-1.7\n%âãÏÓ\n");
    assert.equal(file.kind, "pdf");
    const sent = await admin.json("POST", "/api/chat", { text: "Summarise this", attachments: [file.id] });
    assert.deepEqual(sent, { status: 400, body: { error: "mock-model reads text files only. Pick another model to send report.pdf" } });
    assert.equal(service.requests.length, before, "nothing reached the service");
  });

  test("a JSON body over 1 MB is turned away before anyone signs in", async () => {
    const big = { email: `${"a".repeat(2 * 1024 * 1024)}@example.com`, password: "x" };
    assert.deepEqual(await new Visitor().json("POST", "/api/auth/login", big), { status: 413, body: { error: "That request is too big" } });
    // Sent in pieces, with no length up front, on a connection of its own: the server drops it
    // once it has answered, with the rest of the body unread.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${server.url}/api/auth/login`, { method: "POST", agent: false, headers: { "content-type": "application/json" } });
      req.on("response", (res) => resolve(res.statusCode));
      req.on("error", reject);
      const bytes = Buffer.from(JSON.stringify(big));
      for (let at = 0; at < bytes.length; at += 64 * 1024) req.write(bytes.subarray(at, at + 64 * 1024));
      req.end();
    });
    assert.equal(status, 413);
  });

  test("the connection a body too big came on carries the next request", async () => {
    // One connection only, so the next request goes down the one the big body was turned away on.
    const agent = new Agent({ connections: 1 });
    try {
      const body = JSON.stringify({ email: `${"a".repeat(2 * 1024 * 1024)}@example.com`, password: "x" });
      const big = await undiciFetch(`${server.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body, dispatcher: agent });
      assert.equal(big.status, 413);
      await big.arrayBuffer();
      const next = await undiciFetch(`${server.url}/api/health`, { dispatcher: agent });
      assert.deepEqual({ status: next.status, body: await next.json() }, { status: 200, body: { ok: true } });
    } finally {
      await agent.close();
    }
  });

  test("an address too long for any account is turned down quickly", async () => {
    const started = Date.now();
    // Many dots and no proper end: the address pattern used to take minutes over one like this.
    const email = `a@${"a.".repeat(200_000)}@`;
    assert.equal((await new Visitor().json("POST", "/api/auth/signup", { email, password: "long enough" })).status, 400);
    assert.equal((await new Visitor().json("POST", "/api/auth/login", { email, password: "long enough" })).status, 401);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  });

  test("once a file is in the chat, a note waits for the person's OK on a line in the reply", async () => {
    const file = await admin.upload("lesson plan.txt", "Week 1: atoms\n");
    const before = service.requests.length;
    let chat = "";
    const res = await admin.request("POST", "/api/chat", { text: REMEMBER, attachments: [file.id] });
    const events = await readEvents(res, async (e) => {
      if (e.event === "meta") chat = e.data.conversationId;
      if (e.event !== "asks" || !e.data.asks.length) return;
      const [ask] = e.data.asks;
      assert.deepEqual(ask, {
        id: ask.id,
        kind: "memory",
        question: "Remember this?",
        detail: "Teaches chemistry",
        reason: "This chat has taken in pages, files or tool results, so you're asked before a note is kept",
      });
      // Someone who comes back to the chat finds it waiting too; nobody else can answer it.
      const shown = (await admin.json("GET", `/api/conversations/${chat}`)).body;
      assert.deepEqual([shown.generating, shown.asks], [true, [ask]]);
      assert.equal((await member.json("POST", `/api/conversations/${chat}/asks/${ask.id}`, { allow: true })).status, 404);
      assert.deepEqual(await admin.json("POST", `/api/conversations/${chat}/asks/${ask.id}`, { allow: false }), { status: 200, body: { ok: true } });
    });
    assert.deepEqual(
      events.filter((e) => e.event === "asks").map((e) => e.data.asks.length),
      [1, 0],
    );
    const done = events.find((e) => e.event === "done")!.data.message;
    assert.equal(done.text, "Hi there!");
    assert.deepEqual(done.tools, [{ kind: "memory", text: "Didn't remember “Teaches chemistry” without your OK" }]);
    // The model heard no, and nothing was kept.
    const answered = service.requests.slice(before).find((r) => r.body.stream && r.body.messages.at(-1).role === "tool");
    assert.match(answered!.body.messages.at(-1).content, /^Error: The person didn't allow this/);
    const notes = (await admin.json("GET", "/api/memory")).body;
    assert.ok(!JSON.stringify(notes).includes("Teaches chemistry"));
    assert.equal((await admin.json("POST", `/api/conversations/${chat}/asks/not-waiting`, { allow: true })).status, 409);
  });

  test("an export that unpacks into too much is turned away unread", async () => {
    // About 1 KB that claims to unpack into 4 GB.
    const bomb = zipOf("conversations.json", deflateRawSync(Buffer.alloc(1024 * 1024)), 8, 0xffffffff);
    const res = await admin.request("PUT", "/api/import", bomb);
    assert.deepEqual({ status: res.status, body: await res.json() }, { status: 400, body: { error: "That export is over 200 MB unpacked" } });
  });

  describe("MCP servers on each person's own account", () => {
    let tokens: Awaited<ReturnType<typeof mcpServer>>;
    let signIns: Awaited<ReturnType<typeof mcpServer>>;

    before(async () => {
      tokens = await mcpServer({ auth: "token" });
      tokens.accept("admins-token");
      tokens.accept("members-token");
      signIns = await mcpServer({ auth: "oauth" });
    });
    after(async () => {
      await tokens?.close();
      await signIns?.close();
    });

    /** A GET as this person whose redirect isn't followed: where it pointed. */
    async function redirectFor(visitor: Visitor, path: string) {
      const res = await fetch(server.url + path, { headers: visitor.cookie ? { cookie: visitor.cookie } : {}, redirect: "manual" });
      assert.equal(res.status, 302, await res.text());
      return res.headers.get("location");
    }

    /** Signs in through the server's sign-in page as the browser would, and says where Parley sent the person back to. */
    async function signIn(visitor: Visitor, serverId: number, body: Record<string, unknown> = {}) {
      const start = await visitor.json("POST", `/api/mcp/connections/${serverId}/sign-in`, body);
      assert.equal(start.status, 200, JSON.stringify(start.body));
      const back = new URL((await fetch(start.body.url, { redirect: "manual" })).headers.get("location")!);
      assert.equal(back.origin, server.url, "it comes back to the address the person used");
      return redirectFor(visitor, back.pathname + back.search);
    }

    test("on pasted tokens, the admin's own lists the tools, each person adds theirs, and nobody sees any", async () => {
      const draft = { name: "Notes", url: tokens.url, authMode: "token", tokenHint: "Make one under Settings, then Tokens" };
      assert.deepEqual(await admin.json("POST", "/api/admin/mcp", draft), { status: 400, body: { error: "Paste a token of your own, so it can list its tools" } });
      const added = await admin.json("POST", "/api/admin/mcp", { ...draft, ownToken: "admins-token" });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      const id = added.body.server.id;
      const { authMode, tools, yours, headerNames, people } = added.body.server;
      assert.deepEqual([authMode, tools.length, yours, headerNames, people.map((p: { email: string }) => p.email)], ["token", 4, "connected", [], ["admin@example.com"]]);

      assert.deepEqual((await member.json("GET", "/api/mcp/connections")).body.connections, [
        { id, name: "Notes", mode: "token", host: new URL(tokens.url).host, hint: draft.tokenHint, status: "missing", connectedAt: null, usedAt: null },
      ]);
      assert.deepEqual(await member.json("PUT", `/api/mcp/connections/${id}`, { token: "not-a-token" }), { status: 400, body: { error: "The server turned that token down" } });
      assert.equal((await member.json("PUT", `/api/mcp/connections/${id}`, { token: "members-token" })).body.connection.status, "connected");

      const listed = (await admin.json("GET", "/api/admin/mcp")).body;
      const seen = listed.servers.find((x: { id: number }) => x.id === id);
      assert.deepEqual(seen.people.map((p: { email: string; status: string }) => [p.email, p.status]), [["admin@example.com", "connected"], ["member@example.com", "connected"]]);
      assert.doesNotMatch(JSON.stringify(listed), /admins-token|members-token/);

      assert.equal((await member.json("DELETE", `/api/mcp/connections/${id}`)).body.connection.status, "missing");
      await member.json("PUT", `/api/mcp/connections/${id}`, { token: "members-token" });
      assert.deepEqual((await admin.json("POST", `/api/admin/mcp/${id}/disconnect`, {})).body.server.people, []);
      assert.equal((await member.json("GET", "/api/mcp/connections")).body.connections[0].status, "missing");
      // Nobody signs in to a server on pasted tokens.
      assert.equal((await member.json("POST", `/api/mcp/connections/${id}/sign-in`, {})).status, 404);
      assert.equal((await admin.json("DELETE", `/api/admin/mcp/${id}`)).status, 200);
    });

    test("signing in, the admin's own lists the tools, and each person comes back to where they started", async () => {
      const added = await admin.json("POST", "/api/admin/mcp", { name: "Signed", url: signIns.url, authMode: "oauth" });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      const id = added.body.server.id;
      assert.deepEqual([added.body.server.tools, added.body.server.yours, added.body.server.callbackUrl], [[], "missing", `${server.url}/api/mcp/callback`]);

      signIns.auth.signInAs = "the admin";
      assert.equal(await signIn(admin, id, { from: "admin" }), `/admin/mcp/${id}?result=connected`);
      const listed = (await admin.json("GET", "/api/admin/mcp")).body.servers.find((x: { id: number }) => x.id === id);
      assert.deepEqual([listed.tools.length, listed.yours, listed.error], [4, "connected", null]);

      // Only an admin comes back to the server's page.
      signIns.auth.signInAs = "the member";
      assert.equal(await signIn(member, id, { from: "admin" }), `/account/connections?server=${id}&result=connected`);
      assert.equal((await member.json("GET", "/api/mcp/connections")).body.connections.find((x: { id: number }) => x.id === id).status, "connected");

      signIns.auth.deny = true;
      assert.equal(await signIn(member, id), `/account/connections?server=${id}&result=denied`);
      signIns.auth.deny = false;

      // A sign-in nobody started (or someone else did), or without an account, goes nowhere.
      assert.equal(await redirectFor(member, "/api/mcp/callback?state=made-up&code=x"), "/account/connections?result=expired");
      assert.equal(await redirectFor(new Visitor(), "/api/mcp/callback?state=made-up&code=x"), "/login");
      const theirs = await admin.json("POST", `/api/mcp/connections/${id}/sign-in`, { from: "admin" });
      const back = new URL((await fetch(theirs.body.url, { redirect: "manual" })).headers.get("location")!);
      assert.equal(await redirectFor(member, back.pathname + back.search), "/account/connections?result=expired");

      // A sign-in still under way when the server is closed to the person, or moves, isn't kept.
      const halfway = async (visitor: Visitor) => {
        const start = await visitor.json("POST", `/api/mcp/connections/${id}/sign-in`, {});
        const back = new URL((await fetch(start.body.url, { redirect: "manual" })).headers.get("location")!);
        return back.pathname + back.search;
      };
      await member.json("DELETE", `/api/mcp/connections/${id}`);
      const closing = await halfway(member);
      assert.equal((await admin.json("PATCH", `/api/admin/mcp/${id}`, { shared: false })).status, 200);
      assert.equal(await redirectFor(member, closing), `/account/connections?server=${id}&result=failed`);
      assert.equal((await admin.json("PATCH", `/api/admin/mcp/${id}`, { shared: true })).status, 200);
      assert.equal((await member.json("GET", "/api/mcp/connections")).body.connections.find((x: { id: number }) => x.id === id).status, "missing");

      // A new address forgets everyone's sign-in: they were for the old one.
      const before = await halfway(member);
      const moved = await admin.json("PATCH", `/api/admin/mcp/${id}`, { url: `${signIns.url}?v=2` });
      assert.deepEqual([moved.body.server.people, moved.body.server.yours], [[], "missing"]);
      assert.equal(await redirectFor(member, before), `/account/connections?server=${id}&result=failed`);
      assert.equal((await member.json("GET", "/api/mcp/connections")).body.connections.find((x: { id: number }) => x.id === id).status, "missing");
      assert.equal((await admin.json("DELETE", `/api/admin/mcp/${id}`)).status, 200);
    });
  });
});
