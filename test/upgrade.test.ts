// Upgrading a real install. The last release's own server (its code taken from the git tag) fills
// a database the way people's sites are filled: accounts, a key, chats, a project, memory, a
// knowledge base, a shared link and an MCP server. Then this version's server starts on that file,
// with the same secret. It has to come up with everything there and working, and with what's new
// since working on the old data.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mcpServer } from "./helpers/mcp-server.ts";
import { chunk, completionStream, json, mockServer, modelList, type MockServer } from "./helpers/mock-server.ts";

/** The release whose databases this version has to open. */
const RELEASE = "v0.1.1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function releaseAt(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${RELEASE}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// CI fetches tags for this (fetch-depth: 0); a copy without git history skips it.
const missing = !releaseAt();
if (missing && process.env.CI) throw new Error(`${RELEASE} isn't in this checkout. Fetch tags (actions/checkout with fetch-depth: 0) to test upgrading from it`);

type Site = { child: ChildProcess; url: string; log: () => string };

/** Starts the server in `cwd` (its server/index.ts) on the database, and waits until it listens. */
async function startSite(cwd: string, env: Record<string, string>): Promise<Site> {
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The server in ${cwd} didn't start:\n${log}`)), 15_000);
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
      reject(new Error(`The server in ${cwd} stopped (exit code ${code}):\n${log}`));
    });
  });
  return { child, url: `http://127.0.0.1:${port}`, log: () => log };
}

async function stopSite(site: Site | undefined) {
  if (!site || site.child.exitCode !== null) return;
  site.child.kill();
  await once(site.child, "exit");
}

/** The site being visited: the release's, then this version's on the same database. */
let site: Site;

/** Someone using the site, whose session cookie carries across the upgrade as a browser's would. */
class Visitor {
  cookie = "";

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const raw = body instanceof Uint8Array;
    const res = await fetch(site.url + path, {
      method,
      headers: {
        ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        // What a browser says about a change asked for from one of the site's pages.
        ...(method === "GET" || method === "HEAD" ? {} : { origin: site.url, "sec-fetch-site": "same-origin" }),
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

  /** The same as json(), for a request that has to work. */
  async ok(method: string, path: string, body?: unknown) {
    const res = await this.json(method, path, body);
    assert.equal(res.status, 200, `${method} ${path}: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  /** Sends a message and reads the reply to its end: the chat it went to. */
  async chat(body: Record<string, unknown>): Promise<string> {
    const res = await this.request("POST", "/api/chat", body);
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const meta = /event: meta\ndata: (.*)/.exec(text);
    assert.ok(meta && /event: done\n/.test(text), text);
    return JSON.parse(meta[1]).conversationId;
  }
}

const REPLY = [chunk({ role: "assistant", content: "" }), chunk({ content: "Hi there!" }), chunk({}, "stop")];
const TITLE = {
  id: "chatcmpl-title",
  object: "chat.completion",
  created: 0,
  model: "mock-model",
  choices: [{ index: 0, message: { role: "assistant", content: "Friendly greeting" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
};
const HANDBOOK = "The office opens at nine.\nVisitors sign in at the front desk.\n";

describe(`upgrading from ${RELEASE}`, { skip: missing && `${RELEASE} isn't in this checkout` }, () => {
  const dir = mkdtempSync(join(tmpdir(), "parley-upgrade-"));
  const release = join(dir, RELEASE);
  const env = { DATABASE_PATH: join(dir, "data", "chat.db"), KEY_ENCRYPTION_SECRET: randomBytes(24).toString("hex") };
  const [admin, member] = [new Visitor(), new Visitor()];
  let service: MockServer;
  let mcp: Awaited<ReturnType<typeof mcpServer>>;
  /** What the release left, to find again. */
  const made = { keyId: 0, chat: "", projectId: "", projectChat: "", baseId: "", docId: "", share: "", mcpId: 0 };

  before(async () => {
    service = await mockServer((req) => {
      if (req.method === "GET" && req.path === "/v1/models") return modelList(["mock-model"]);
      if (req.method === "POST" && req.path === "/v1/chat/completions") return req.body.stream ? completionStream(REPLY) : json(TITLE);
      throw new Error(`Unexpected ${req.method} ${req.path}`);
    });
    mcp = await mcpServer({ auth: "token" });
    mcp.accept("notes-token");

    // The release's server, from its tag, with this checkout's packages.
    mkdirSync(release);
    const tarball = execFileSync("git", ["archive", "--format=tar", RELEASE, "server", "package.json"], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", release], { input: tarball });
    symlinkSync(join(ROOT, "node_modules"), join(release, "node_modules"), "dir");

    site = await startSite(release, env);
    try {
      await admin.ok("POST", "/api/auth/signup", { email: "admin@example.com", password: "correct horse" });
      await member.ok("POST", "/api/auth/signup", { email: "member@example.com", password: "battery staple" });
      made.keyId = (
        await admin.ok("POST", "/api/admin/keys", {
          label: "Mock service",
          provider: "custom",
          effort: "default",
          apiKey: "sk-upgrade-0001",
          model: "mock-model",
          endpoint: { baseUrl: `${service.url}/v1`, models: [{ id: "mock-model" }] },
        })
      ).id;
      made.chat = await admin.chat({ text: "Hello there" });
      made.share = (await admin.ok("POST", `/api/conversations/${made.chat}/share`, {})).share.token;

      made.projectId = (await member.ok("POST", "/api/projects", { name: "Thesis", instructions: "Answer briefly" })).project.id;
      made.projectChat = await member.chat({ text: "Plan the database migration for the lab", projectId: made.projectId });
      await member.ok("POST", "/api/memory", { text: "Teaches chemistry" });
      made.baseId = (await member.ok("POST", "/api/knowledge", { name: "Handbook" })).knowledge.id;
      const doc = await member.request("PUT", `/api/knowledge/${made.baseId}/docs`, Buffer.from(HANDBOOK), { "x-file-name": "handbook.txt" });
      assert.equal(doc.status, 200, await doc.clone().text());
      made.docId = ((await doc.json()) as { doc: { id: string } }).doc.id;

      made.mcpId = (await admin.ok("POST", "/api/admin/mcp", { name: "Notes", url: mcp.url, headers: "Authorization: Bearer notes-token" })).server.id;
      await admin.ok("PATCH", "/api/admin/settings", { allowSignup: false });
    } finally {
      await stopSite(site);
    }

    site = await startSite(ROOT, env);
  });

  after(async () => {
    await stopSite(site);
    await service?.close();
    await mcp?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("comes up on the release's database, which stays whole", async () => {
    assert.deepEqual(await new Visitor().json("GET", "/api/health"), { status: 200, body: { ok: true } });
    const db = new DatabaseSync(env.DATABASE_PATH, { readOnly: true });
    try {
      assert.deepEqual({ ...db.prepare("PRAGMA integrity_check").get() }, { integrity_check: "ok" });
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      // What's new is there, around what was.
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      assert.ok(tables.includes("mcp_credentials"));
      const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
      for (const column of ["auth_mode", "pending_tools", "tool_modes", "send_user"]) assert.ok(columns("mcp_servers").includes(column), column);
      assert.ok(columns("messages").includes("page_urls"));
    } finally {
      db.close();
    }
  });

  test("people stay signed in, and can sign in again", async () => {
    assert.equal((await admin.ok("GET", "/api/auth/me")).user.role, "admin");
    assert.equal((await member.ok("GET", "/api/auth/me")).user.email, "member@example.com");
    const again = new Visitor();
    await again.ok("POST", "/api/auth/login", { email: "member@example.com", password: "battery staple" });
    assert.equal((await again.ok("GET", "/api/auth/me")).user.email, "member@example.com");
    assert.equal((await admin.ok("GET", "/api/admin/settings")).settings.allowSignup, false);
  });

  test("chats, the project, memory, the knowledge base and the shared link are all there", async () => {
    const chat = await admin.ok("GET", `/api/conversations/${made.chat}`);
    assert.equal(chat.conversation.title, "Friendly greeting");
    assert.deepEqual(chat.messages.map((m: { role: string; text: string }) => [m.role, m.text]), [["user", "Hello there"], ["assistant", "Hi there!"]]);
    assert.deepEqual(chat.asks, []);

    const project = (await member.ok("GET", `/api/projects/${made.projectId}`)).project;
    assert.deepEqual([project.name, project.instructions, project.chats], ["Thesis", "Answer briefly", 1]);
    const listed = (await member.ok("GET", "/api/conversations")).conversations;
    assert.deepEqual(listed.map((c: { id: string; projectId: string | null }) => [c.id, c.projectId]), [[made.projectChat, made.projectId]]);

    assert.deepEqual((await member.ok("GET", "/api/memory")).memories.map((m: { text: string }) => m.text), ["Teaches chemistry"]);

    const base = await member.ok("GET", `/api/knowledge/${made.baseId}`);
    assert.deepEqual([base.knowledge.name, base.docs.map((d: { name: string }) => d.name)], ["Handbook", ["handbook.txt"]]);
    const file = await member.request("GET", `/api/knowledge/${made.baseId}/docs/${made.docId}`);
    assert.equal(await file.text(), HANDBOOK);

    const shared = await new Visitor().json("GET", `/api/shared/${made.share}`);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.match(JSON.stringify(shared.body), /Hi there!/);
  });

  test("the key still opens, and an old chat goes on", async () => {
    const before = service.requests.length;
    assert.equal(await admin.chat({ conversationId: made.chat, text: "And again" }), made.chat);
    const reply = service.requests.slice(before).find((r) => r.body?.stream)!;
    assert.equal(reply.headers.authorization, "Bearer sk-upgrade-0001");
    assert.deepEqual(
      reply.body.messages.filter((m: { role: string }) => m.role !== "system").map((m: { role: string; content: unknown }) => [m.role, m.content]),
      [["user", "Hello there"], ["assistant", "Hi there!"], ["user", "And again"]],
    );
    const chat = await admin.ok("GET", `/api/conversations/${made.chat}`);
    assert.equal(chat.messages.length, 4);
  });

  test("search finds chats the release kept", async () => {
    const found = (await member.ok("GET", `/api/conversations/search?q=${encodeURIComponent("database migration")}`)).results;
    assert.deepEqual(found.map((r: { id: string; snippet: string }) => [r.id, r.snippet]), [[made.projectChat, "Plan the database migration for the lab"]]);
    assert.deepEqual((await admin.ok("GET", "/api/conversations/search?q=migration")).results, []);
  });

  test("an MCP server from before keeps its headers, asks first, and has its tools looked over when listed again", async () => {
    const server = () => admin.ok("GET", "/api/admin/mcp").then((r) => r.servers.find((s: { id: number }) => s.id === made.mcpId));
    const kept = await server();
    assert.deepEqual(
      [kept.authMode, kept.headerNames, kept.people, kept.pending, kept.runTools, kept.tools.length],
      ["shared", ["Authorization"], [], null, [], 4],
    );
    assert.deepEqual((await member.ok("GET", "/api/mcp/connections")).connections, []);

    // Listed again with the headers kept from before (the server takes nothing else), what each tool
    // says it does is new, and waits to be looked over.
    const listed = (await admin.ok("POST", `/api/admin/mcp/${made.mcpId}/refresh`, {})).server;
    assert.equal(listed.error, null);
    assert.ok(listed.pending.changes.length > 0);
    for (const change of listed.pending.changes) assert.deepEqual([change.change, change.parts], ["changed", ["hints"]], change.name);
    const used = (await admin.ok("POST", `/api/admin/mcp/${made.mcpId}/pending`, { use: true, version: listed.pending.version })).server;
    assert.deepEqual([used.pending, used.runTools], [null, ["read_notes"]]);
  });
});
