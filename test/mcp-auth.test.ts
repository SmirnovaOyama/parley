// MCP servers on each person's own account (server/mcp-auth.ts): a person's calls carry their own
// token or sign-in and nobody else's, never the admin's headers; one who hasn't connected gets a
// line saying where to; sign-ins refresh, and stop working when the service says so; and accounts
// are forgotten when the person can't use the server any more.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { encryptSecret } from "../server/crypto.ts";
import { db, nowIso } from "../server/db.ts";
import { accountMessage, callTool, declareTools, disconnect, forget, getServer, listTools, refreshServer, sweepCredentials, USER_HEADER } from "../server/mcp.ts";
import { accountState, credentialOf, finishSignIn, oauthFetch, saveCredential, startSignIn, takeSignIn } from "../server/mcp-auth.ts";
import { chatToolkit, type DeclaredTool } from "../server/tools.ts";
import { mcpServer } from "./helpers/mcp-server.ts";

function person(email: string, role: "user" | "admin" = "user"): number {
  return Number(db.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'x', ?, ?)").run(email, role, nowIso()).lastInsertRowid);
}

function addServer(name: string, url: string, mode: "oauth" | "token", tools = "[]"): number {
  return Number(
    db
      .prepare("INSERT INTO mcp_servers (name, url, encrypted_headers, enabled, shared, tools, auth_mode, created_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?)")
      // The admin's headers are there too, to show they're never sent on a server like this.
      .run(name, url, encryptSecret(JSON.stringify({ Authorization: "Bearer admins-own", "X-Team": "ops" })), tools, mode, nowIso())
      .lastInsertRowid,
  );
}

const signal = new AbortController().signal;
const CALLBACK = "http://parley.test/api/mcp/callback";

/** A toolkit for this person whose questions all get "allow", with the questions it asked. */
function kit(userId: number, declared: DeclaredTool[]) {
  const asked: unknown[] = [];
  const tools = chatToolkit({
    userId,
    conversationId: "chat",
    declared,
    context: { linked: [], outside: false },
    ask: async (question) => (asked.push(question), "allow"),
    signal,
    onStatus: () => {},
  });
  return Object.assign(tools, { asked });
}

/** Waits a moment for something done in the background, like a revoke. */
async function eventually(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
}

describe("each person's own token", () => {
  let mcp: Awaited<ReturnType<typeof mcpServer>>;
  let serverId: number;
  const [alice, bob] = [person("alice@tokens.example"), person("bob@tokens.example")];
  const server = () => getServer(serverId)!;

  before(async () => {
    mcp = await mcpServer({ auth: "token" });
    mcp.accept("alices-token");
    mcp.accept("bobs-token");
    serverId = addServer("Notes", mcp.url, "token", JSON.stringify(await listTools(mcp.url, { Authorization: "Bearer alices-token" })));
  });
  after(async () => {
    forget(serverId);
    await mcp.close();
  });

  test("a person who hasn't connected doesn't reach the server at all", async () => {
    assert.equal(accountState(server(), alice), "missing");
    const sessions = mcp.sessions();
    const outcome = await callTool(server(), alice, "read_notes", {}, signal);
    assert.deepEqual(outcome, { content: accountMessage(server(), "missing"), isError: true, account: "missing" });
    assert.match(outcome.content, /hasn't connected theirs, so this didn't run\. They can connect it in Account, under Connected services/);
    assert.equal(mcp.calls.length, 0);
    assert.equal(mcp.sessions(), sessions);
  });

  test("calls carry the person's own token, and never the admin's headers", async () => {
    saveCredential(serverId, alice, { kind: "token", headers: { Authorization: "Bearer alices-token" } });
    saveCredential(serverId, bob, { kind: "token", headers: { Authorization: "Bearer bobs-token" } });
    await callTool(server(), alice, "read_notes", {}, signal);
    await callTool(server(), bob, "read_notes", {}, signal);
    assert.deepEqual(mcp.calls.map((c) => c.account), ["alices-token", "bobs-token"]);
    for (const c of mcp.calls) assert.equal(c.headers["x-team"], undefined);
    assert.notEqual(mcp.calls[0].session, mcp.calls[1].session);
    assert.ok(credentialOf(serverId, alice)!.used_at);
  });

  test("a person can't say they're someone else", async () => {
    db.prepare("UPDATE mcp_servers SET send_user = 1 WHERE id = ?").run(serverId);
    saveCredential(serverId, bob, { kind: "token", headers: { Authorization: "Bearer bobs-token", "x-parley-user": "alice@tokens.example" } });
    await callTool(server(), bob, "ping", {}, signal);
    assert.equal(mcp.calls.at(-1)!.headers[USER_HEADER.toLowerCase()], "bob@tokens.example");
    db.prepare("UPDATE mcp_servers SET send_user = 0 WHERE id = ?").run(serverId);
    forget(serverId);
    await callTool(server(), bob, "ping", {}, signal);
    assert.equal(mcp.calls.at(-1)!.headers[USER_HEADER.toLowerCase()], undefined);
  });

  test("a token the server turns down needs connecting again", async () => {
    mcp.drop("bobs-token");
    const outcome = await callTool(server(), bob, "ping", {}, signal);
    assert.equal(outcome.account, "expired");
    assert.match(outcome.content, /token for Notes has stopped working/);
    assert.equal(accountState(server(), bob), "expired");
    assert.equal(credentialOf(serverId, bob)!.secret, null, "the token isn't kept");
    // Alice's still works.
    assert.equal((await callTool(server(), alice, "ping", {}, signal)).isError, false);
  });

  test("in a chat, a tool says where to connect, before anything is asked", async () => {
    const carol = person("carol@tokens.example");
    const declared = declareTools([server()]);
    const tools = kit(carol, declared);
    const before = mcp.calls.length;
    const outcome = await tools.offer(false).runTool({ id: "1", name: declared.find((t) => t.mcp.tool === "add_note")!.name, input: { text: "Hi" } });
    assert.deepEqual(outcome, { content: accountMessage(server(), "missing"), isError: true });
    assert.deepEqual(tools.uses, [{ kind: "mcp", text: "Couldn't use add_note on Notes without your own account there", error: true, connect: true }]);
    assert.deepEqual(tools.asked, []);
    assert.equal(mcp.calls.length, before);

    const again = kit(bob, declared);
    await again.offer(false).runTool({ id: "1", name: declared.find((t) => t.mcp.tool === "read_notes")!.name, input: {} });
    assert.deepEqual(again.uses, [{ kind: "mcp", text: "Couldn't use read_notes on Notes, as your account there stopped working", error: true, connect: true }]);
  });

  test("listing its tools takes the admin's own token", async () => {
    const admin = person("admin@tokens.example", "admin");
    assert.match((await refreshServer(server(), admin)).error ?? "", /Add a token of your own first/);
    saveCredential(serverId, admin, { kind: "token", headers: { Authorization: "Bearer alices-token" } });
    const listed = await refreshServer(server(), admin);
    assert.equal(listed.error, null);
    assert.equal(JSON.parse(listed.tools).length, 4);
  });
});

describe("signing in on the server's own page", () => {
  let mcp: Awaited<ReturnType<typeof mcpServer>>;
  let serverId: number;
  const [alice, bob, carol] = [person("alice@oauth.example"), person("bob@oauth.example"), person("carol@oauth.example")];
  const server = () => getServer(serverId)!;

  /** Signs a person in as `account`, the way their browser would go: to the sign-in page, and back. */
  async function signIn(userId: number, account: string) {
    mcp.auth.signInAs = account;
    const page = await startSignIn(server(), userId, CALLBACK, "account");
    const res = await fetch(page, { redirect: "manual" });
    const back = new URL(res.headers.get("location")!);
    assert.equal(`${back.origin}${back.pathname}`, CALLBACK);
    const held = takeSignIn(back.searchParams.get("state")!, userId);
    assert.ok(held);
    await finishSignIn(server(), held, back.searchParams.get("code")!);
  }

  before(async () => {
    mcp = await mcpServer({ auth: "oauth" });
    serverId = addServer("Notes", mcp.url, "oauth");
  });
  after(async () => {
    forget(serverId);
    await mcp.close();
  });

  test("registers Parley once, and sends people to the sign-in page with PKCE", async () => {
    const page = new URL(await startSignIn(server(), alice, CALLBACK, "account"));
    assert.equal(page.origin + page.pathname, mcp.url.replace(/\/mcp$/, "/authorize"));
    const q = page.searchParams;
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("client_id"), "client-1");
    assert.equal(q.get("redirect_uri"), CALLBACK);
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.ok(q.get("code_challenge") && q.get("state"));
    assert.equal(q.get("resource"), mcp.url);
    assert.deepEqual(mcp.auth.registrations.map((r) => [r.client_name, r.redirect_uris]), [["Parley", [CALLBACK]]]);
    // The same registration serves everyone coming back to the same address; another address registers again.
    await startSignIn(server(), bob, CALLBACK, "account");
    assert.equal(mcp.auth.registrations.length, 1);
    await startSignIn(server(), bob, "https://elsewhere.test/api/mcp/callback", "account");
    assert.equal(mcp.auth.registrations.length, 2);
  });

  test("a sign-in comes back only to the person who started it, and once", async () => {
    const state = new URL(await startSignIn(server(), alice, CALLBACK, "account")).searchParams.get("state")!;
    assert.equal(takeSignIn(state, bob), null);
    assert.equal(takeSignIn(state, alice), null, "a wrong try uses it up");
    const again = new URL(await startSignIn(server(), alice, CALLBACK, "account")).searchParams.get("state")!;
    assert.ok(takeSignIn(again, alice));
    assert.equal(takeSignIn(again, alice), null);
  });

  test("keeps each person's sign-in, and calls as them", async () => {
    await signIn(alice, "alice");
    await signIn(bob, "bob");
    await callTool(server(), alice, "read_notes", {}, signal);
    await callTool(server(), bob, "read_notes", {}, signal);
    assert.deepEqual(mcp.calls.map((c) => c.account), ["alice", "bob"]);
    for (const c of mcp.calls) assert.match(String(c.headers.authorization), /^Bearer at-/);
  });

  test("refreshes a token the server turns down, once however many calls want it", async () => {
    mcp.expireAccess();
    const before = mcp.auth.refreshes;
    const outcomes = await Promise.all([1, 2, 3].map(() => callTool(server(), alice, "read_notes", {}, signal)));
    for (const o of outcomes) assert.equal(o.isError, false, o.content);
    assert.equal(mcp.auth.refreshes, before + 1);
    assert.deepEqual(mcp.calls.slice(-3).map((c) => c.account), ["alice", "alice", "alice"]);
  });

  test("refreshes ahead of time when a token is about to run out", async () => {
    mcp.auth.expiresIn = 30;
    await signIn(carol, "carol");
    mcp.auth.expiresIn = 3600;
    const [refreshes, turnedDown] = [mcp.auth.refreshes, mcp.auth.turnedDown];
    assert.equal((await callTool(server(), carol, "ping", {}, signal)).isError, false);
    assert.equal(mcp.auth.refreshes, refreshes + 1);
    assert.equal(mcp.auth.turnedDown, turnedDown, "the old token was never tried");
  });

  test("a sign-in the service withdrew means signing in again", async () => {
    mcp.withdrawAll();
    forget(serverId);
    const outcome = await callTool(server(), bob, "ping", {}, signal);
    assert.equal(outcome.account, "expired");
    assert.match(outcome.content, /sign-in for Notes has stopped working/);
    assert.equal(accountState(server(), bob), "expired");
    await signIn(bob, "bob");
    assert.equal(accountState(server(), bob), null);
    assert.equal((await callTool(server(), bob, "ping", {}, signal)).isError, false);
  });

  test("disconnecting forgets the sign-in and asks the service to withdraw it", async () => {
    disconnect(serverId, bob);
    assert.equal(credentialOf(serverId, bob), undefined);
    await eventually(() => mcp.auth.revoked.some((t) => t.startsWith("rt-bob-")));
    assert.equal((await callTool(server(), bob, "ping", {}, signal)).account, "missing");
  });

  test("the person's choice not to sign in is respected", async () => {
    mcp.auth.deny = true;
    try {
      const page = await startSignIn(server(), bob, CALLBACK, "account");
      const back = new URL((await fetch(page, { redirect: "manual" })).headers.get("location")!);
      assert.equal(back.searchParams.get("error"), "access_denied");
      assert.equal(back.searchParams.get("code"), null);
    } finally {
      mcp.auth.deny = false;
    }
  });

  test("an address the server names away from its own host has to be on the public web", async () => {
    await assert.rejects(oauthFetch(mcp.url)("http://10.0.0.1/token"), /inside this server's network/);
    await assert.rejects(oauthFetch(mcp.url)("http://169.254.169.254/latest/meta-data"), /inside this server's network/);
    // Its own host is where an admin pointed Parley, so that's reached as it is.
    assert.equal((await oauthFetch(mcp.url)(mcp.url.replace(/\/mcp$/, "/.well-known/oauth-authorization-server"))).status, 200);
  });

  test("a sign-in page that isn't a web page is refused", async () => {
    mcp.auth.authorizeAt = "javascript:alert(document.cookie)//";
    try {
      await assert.rejects(startSignIn(server(), carol, CALLBACK, "account"));
    } finally {
      mcp.auth.authorizeAt = "";
    }
  });

  test("a service that won't register Parley needs a client from an admin", async () => {
    mcp.auth.registration = false;
    const other = addServer("Other", mcp.url, "oauth");
    try {
      await assert.rejects(startSignIn(getServer(other)!, carol, CALLBACK, "account"), /dynamic client registration/);
    } finally {
      mcp.auth.registration = true;
      db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(other);
    }
  });
});

describe("who keeps their account", () => {
  const url = "http://127.0.0.1:9/mcp";
  const admin = person("admin@keeps.example", "admin");
  const [dana, eli, finn] = [person("dana@keeps.example"), person("eli@keeps.example"), person("finn@keeps.example")];
  const token = { kind: "token" as const, headers: { Authorization: "Bearer x" } };
  const kept = (serverId: number) => (db.prepare("SELECT user_id FROM mcp_credentials WHERE server_id = ? ORDER BY user_id").all(serverId) as { user_id: number }[]).map((r) => r.user_id);

  test("only while they may use the server", () => {
    const serverId = addServer("Groups only", url, "token");
    db.prepare("UPDATE mcp_servers SET shared = 0 WHERE id = ?").run(serverId);
    const group = Number(db.prepare("INSERT INTO user_groups (name, created_at) VALUES ('Team', ?)").run(nowIso()).lastInsertRowid);
    db.prepare("INSERT INTO group_mcp (group_id, server_id) VALUES (?, ?)").run(group, serverId);
    for (const id of [dana, eli, finn]) db.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").run(group, id);
    for (const id of [admin, dana, eli, finn]) saveCredential(serverId, id, token);

    // Out of the group, turned off, or deleted: forgotten. The admin, in no group, keeps theirs.
    db.prepare("DELETE FROM group_members WHERE user_id = ?").run(dana);
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(eli);
    sweepCredentials();
    assert.deepEqual(kept(serverId), [admin, finn]);
    db.prepare("DELETE FROM users WHERE id = ?").run(finn);
    assert.deepEqual(kept(serverId), [admin]);

    // Shared again: nobody's own account is used, so none is kept.
    db.prepare("UPDATE mcp_servers SET auth_mode = 'shared' WHERE id = ?").run(serverId);
    sweepCredentials();
    assert.deepEqual(kept(serverId), []);
  });

  test("and never past the server", () => {
    const serverId = addServer("Going", url, "token");
    saveCredential(serverId, admin, token);
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(serverId);
    assert.deepEqual(kept(serverId), []);
  });
});
