// The API end to end: the real server (server/index.ts) in a child process, on a temporary
// database with a throwaway secret, talking to a mock "another service" for its replies.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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

/**
 * Asks for a link to reset the password of `email`, as someone at `network`. The server reads
 * that from X-Forwarded-For, which it trusts from this machine as from a proxy in front of it.
 */
async function forgot(email: string, network = "203.0.113.1") {
  const res = await new Visitor().request("POST", "/api/auth/forgot", { email }, { "x-forwarded-for": network });
  return { status: res.status, body: (await res.json()) as any };
}

/**
 * The token in the last reset link sent to `email` since the server's log was `from` long. In
 * development mail goes to the server's log, so that's where it's read.
 */
async function resetToken(email: string, from: number): Promise<string> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const sent = server.log().slice(from).split("[mail] to ").filter((mail) => mail.startsWith(`${email}:`));
    const token = sent.at(-1)?.match(/\/reset-password#([\w-]+)/)?.[1];
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No reset link was sent to ${email}:\n${server.log().slice(from)}`);
}

/** Changes the database under the server, as time passing would. */
function writeDatabase(sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(DATABASE_PATH, { timeout: 5000 });
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
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

/** The service's reply to a chat message: reasoning, two pieces of answer, then usage with a cache hit. */
const REPLY = [
  chunk({ role: "assistant", content: "" }),
  chunk({ reasoning_content: "Thinking it over." }),
  chunk({ content: "Hi" }),
  chunk({ content: " there!" }),
  chunk({}, "stop"),
  usageChunk({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } }),
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
    if (req.method === "POST" && req.path === "/v1/chat/completions") return req.body.stream ? completionStream(REPLY) : json(TITLE);
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
    assert.deepEqual((await admin.json("GET", "/api/auth/state")).body, { needsSetup: true, allowSignup: true, passwordReset: true });
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

  test("asking for a reset link gets the same answer whether or not an account uses the address", async () => {
    assert.deepEqual(await forgot("not an address"), { status: 400, body: { error: "Enter a valid email address" } });
    const from = server.log().length;
    const unknown = await forgot("nobody@example.com");
    const known = await forgot(" Member@Example.com");
    assert.deepEqual(unknown, { status: 200, body: { ok: true, resendIn: 60, mail: "dev" } });
    assert.deepEqual(known, unknown);
    // The mail log is in order, so had the unknown address been sent anything, it would be there by now.
    await resetToken("member@example.com", from);
    assert.doesNotMatch(server.log().slice(from), /\[mail\] to nobody@example\.com/);

    // Asking again straight away is too soon, for both alike.
    const again = await forgot("nobody@example.com");
    assert.deepEqual(again, { status: 429, body: { error: "A link for that address was just asked for. Wait a minute before asking again" } });
    assert.deepEqual(await forgot("member@example.com"), again);
  });

  test("a reset link sets a new password once, signs its opener in and everyone else out", async () => {
    const email = "forgetful@example.com";
    const first = new Visitor();
    assert.equal((await first.json("POST", "/api/auth/signup", { email, password: "first password" })).status, 200);
    const laptop = new Visitor();
    assert.equal((await laptop.json("POST", "/api/auth/login", { email, password: "first password" })).status, 200);

    const from = server.log().length;
    assert.equal((await forgot(email)).status, 200);
    const token = await resetToken(email, from);

    const phone = new Visitor();
    assert.deepEqual(await phone.json("POST", "/api/auth/reset/check", { token }), { status: 200, body: { email } });
    // A password that's too short is turned away without using the link up.
    assert.deepEqual(await phone.json("POST", "/api/auth/reset", { token, password: "short" }), {
      status: 400,
      body: { error: "Use at least 8 characters for the password" },
    });
    assert.deepEqual(await phone.json("POST", "/api/auth/reset", { token, password: "second password" }), { status: 200, body: { ok: true } });
    assert.equal((await phone.json("GET", "/api/auth/me")).body.user.email, email);
    assert.equal((await first.json("GET", "/api/auth/me")).status, 401);
    assert.equal((await laptop.json("GET", "/api/auth/me")).status, 401);

    const dead = { status: 400, body: { error: "This link has expired or was already used. Ask for a new one" } };
    assert.deepEqual(await new Visitor().json("POST", "/api/auth/reset/check", { token }), dead);
    assert.deepEqual(await new Visitor().json("POST", "/api/auth/reset", { token, password: "third password" }), dead);
    assert.equal((await new Visitor().json("POST", "/api/auth/login", { email, password: "first password" })).status, 401);
    assert.equal((await new Visitor().json("POST", "/api/auth/login", { email, password: "second password" })).status, 200);
  });

  test("a reset link stops working when it expires, a newer one is sent, or the password changes", async () => {
    const email = "twice@example.com";
    const owner = new Visitor();
    assert.equal((await owner.json("POST", "/api/auth/signup", { email, password: "first password" })).status, 200);
    const userId: number = (await owner.json("GET", "/api/auth/me")).body.user.id;
    const check = async (token: string) => (await new Visitor().json("POST", "/api/auth/reset/check", { token })).status;

    // A link as the server keeps one (the hash of its token), sent `ago` minutes back.
    const older = randomBytes(32).toString("base64url");
    const saveLink = (ago: number) => {
      const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
      writeDatabase(
        `INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at`,
        userId,
        createHash("sha256").update(older).digest("hex"),
        at(30 - ago),
        at(-ago),
      );
    };
    saveLink(31);
    assert.equal(await check(older), 400);
    assert.equal((await new Visitor().json("POST", "/api/auth/reset", { token: older, password: "second password" })).status, 400);

    saveLink(20);
    assert.equal(await check(older), 200);
    const from = server.log().length;
    assert.equal((await forgot(email)).status, 200);
    const newer = await resetToken(email, from);
    assert.equal(await check(older), 400);
    assert.equal(await check(newer), 200);

    assert.equal((await owner.json("POST", "/api/auth/password", { current: "first password", next: "second password" })).status, 200);
    assert.equal(await check(newer), 400);
  });

  test("a reset doesn't get round a turned-off account", async () => {
    const [paused, off] = ["paused@example.com", "off@example.com"];
    for (const email of [paused, off]) {
      assert.equal((await new Visitor().json("POST", "/api/auth/signup", { email, password: "first password" })).status, 200);
    }
    const from = server.log().length;
    assert.equal((await forgot(paused)).status, 200);
    const token = await resetToken(paused, from);

    const people: { id: number; email: string }[] = (await admin.json("GET", "/api/admin/users")).body.users;
    for (const email of [paused, off]) {
      const id = people.find((p) => p.email === email)!.id;
      assert.equal((await admin.json("PATCH", `/api/admin/users/${id}`, { disabled: true })).status, 200);
    }
    const turnedOff = { status: 403, body: { error: "This account is turned off. Ask an admin" } };
    const visitor = new Visitor();
    assert.deepEqual(await visitor.json("POST", "/api/auth/reset/check", { token }), turnedOff);
    assert.deepEqual(await visitor.json("POST", "/api/auth/reset", { token, password: "second password" }), turnedOff);
    assert.equal(visitor.cookie, "", "nobody was signed in");
    // The old password still matches (the account is off, not the password wrong).
    assert.deepEqual(await new Visitor().json("POST", "/api/auth/login", { email: paused, password: "first password" }), turnedOff);

    // An account that's off is answered like any other, and sent nothing.
    const mark = server.log().length;
    assert.deepEqual(await forgot(off), { status: 200, body: { ok: true, resendIn: 60, mail: "dev" } });
    assert.equal((await forgot("admin@example.com")).status, 200);
    await resetToken("admin@example.com", mark);
    assert.doesNotMatch(server.log().slice(mark), /\[mail\] to off@example\.com/);
  });

  test("reset links are limited by network as well as by address", async () => {
    const network = "198.51.100.7";
    for (let i = 0; i < 20; i++) assert.equal((await forgot(`stranger${i}@example.com`, network)).status, 200, `request ${i + 1}`);
    assert.deepEqual(await forgot("stranger20@example.com", network), {
      status: 429,
      body: { error: "Too many links asked for from here. Try again in an hour" },
    });
    assert.equal((await forgot("stranger20@example.com", "198.51.100.8")).status, 200);
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

  test("an export that unpacks into too much is turned away unread", async () => {
    // About 1 KB that claims to unpack into 4 GB.
    const bomb = zipOf("conversations.json", deflateRawSync(Buffer.alloc(1024 * 1024)), 8, 0xffffffff);
    const res = await admin.request("PUT", "/api/import", bomb);
    assert.deepEqual({ status: res.status, body: await res.json() }, { status: 400, body: { error: "That export is over 200 MB unpacked" } });
  });
});
