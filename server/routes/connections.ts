// A person's own accounts on the MCP servers that act with each person's (mcp-auth.ts): where they
// stand with each, connecting one (signing in on the server's own page, or pasting a token), and
// disconnecting it. Admins connect their own here too, from a server's page, to list its tools.
import { Hono } from "hono";
import { originOf, requireUser, type AppEnv, type SessionUser } from "../auth.ts";
import {
  canUseServer,
  disconnect,
  fetchWithHeaders,
  forgetPerson,
  getServer,
  listTools,
  mcpErrorMessage,
  parseHeaders,
  refreshServer,
  serversFor,
  toolsOf,
  type McpServerRow,
} from "../mcp.ts";
import {
  callbackUrl,
  credentialOf,
  finishSignIn,
  ownHeaders,
  personal,
  saveCredential,
  signInErrorMessage,
  startSignIn,
  takeSignIn,
  type SignInFrom,
} from "../mcp-auth.ts";

export const connectionRoutes = new Hono<AppEnv>();

/** A server as a person's Connected services page shows it: how it's connected and where they stand. */
function connectionOut(s: McpServerRow, userId: number) {
  const row = credentialOf(s.id, userId);
  return {
    id: s.id,
    name: s.name,
    mode: s.auth_mode as "oauth" | "token",
    /** Where the server is, so people know whose sign-in page to expect. */
    host: new URL(s.url).host,
    /** What an admin tells people to paste, for a server on pasted tokens. */
    hint: s.token_hint ?? "",
    status: !row ? "missing" : row.status === "ok" ? "connected" : "expired",
    connectedAt: row?.connected_at ?? null,
    usedAt: row?.used_at ?? null,
  };
}

/** A server this person may connect their own account to: one open to them, or any at all for an admin, whose own lists its tools. */
function serverToConnect(id: number, user: SessionUser): McpServerRow | null {
  const s = getServer(id);
  if (!s || !personal(s)) return null;
  return canUseServer(s, user.id) || user.role === "admin" ? s : null;
}

connectionRoutes.get("/mcp/connections", requireUser, (c) => {
  const userId = c.var.user!.id;
  return c.json({ connections: serversFor(userId).filter(personal).map((s) => connectionOut(s, userId)) });
});

/** Starts signing in to a server: the answer is its sign-in page, for the browser to go to. */
connectionRoutes.post("/mcp/connections/:id/sign-in", requireUser, async (c) => {
  const user = c.var.user!;
  const body = await c.req.json().catch(() => ({}));
  const from: SignInFrom = body.from === "admin" && user.role === "admin" ? "admin" : "account";
  const s = serverToConnect(Number(c.req.param("id")), user);
  if (!s || s.auth_mode !== "oauth") return c.json({ error: "There's no server to sign in to here" }, 404);
  try {
    return c.json({ url: await startSignIn(s, user.id, callbackUrl(originOf(c)), from) });
  } catch (err) {
    console.error(`[mcp] signing in to ${s.name} couldn't start:`, err);
    return c.json({ error: signInErrorMessage(err) }, 400);
  }
});

/**
 * Where a server's sign-in page sends the person back, with a code or the reason there's none.
 * It goes on to the page the sign-in started from, saying how it went.
 */
connectionRoutes.get("/mcp/callback", async (c) => {
  const user = c.var.user;
  if (!user) return c.redirect("/login");
  const held = takeSignIn(c.req.query("state") ?? "", user.id);
  if (!held) return c.redirect("/settings/connections?result=expired");
  const back = (result: "connected" | "denied" | "failed") =>
    c.redirect(held.from === "admin" ? `/admin/mcp/${held.serverId}?result=${result}` : `/settings/connections?server=${held.serverId}&result=${result}`);
  // Still a server this person may connect, signed in to at the address it started for.
  const s = serverToConnect(held.serverId, user);
  const code = c.req.query("code");
  if (!s || s.auth_mode !== "oauth" || s.url !== held.serverUrl) return back("failed");
  if (!code) return back(c.req.query("error") === "access_denied" ? "denied" : "failed");
  try {
    await finishSignIn(s, held, code);
  } catch (err) {
    console.error(`[mcp] signing in to ${s.name} couldn't finish:`, err);
    return back("failed");
  }
  forgetPerson(s.id, user.id);
  // An admin signing in from the server's page does it so the server lists its tools. The first
  // time, that's the end of adding it, so they're taken as they are; later, new ones wait for a look.
  if (held.from === "admin" && user.role === "admin") await refreshServer(getServer(s.id)!, user.id, !toolsOf(s).length && !s.pending_tools);
  return back("connected");
});

/** Keeps a person's token for a server on pasted tokens, once the server has taken it. */
connectionRoutes.put("/mcp/connections/:id", requireUser, async (c) => {
  const user = c.var.user!;
  const s = serverToConnect(Number(c.req.param("id")), user);
  if (!s || s.auth_mode !== "token") return c.json({ error: "There's no server to add a token to here" }, 404);
  const parsed = parseHeaders((await c.req.json().catch(() => ({}))).token);
  if ("error" in parsed) return c.json(parsed, 400);
  const headers = ownHeaders(parsed as Record<string, string>);
  if (Object.keys(headers).length < Object.keys(parsed).length) return c.json({ error: "Leave out X-Parley-User: Parley sets that itself" }, 400);
  if (!Object.keys(headers).length) return c.json({ error: "Paste your token" }, 400);
  // Tried before it's kept: the server lists its tools with it.
  try {
    await listTools(s.url, fetchWithHeaders(headers));
  } catch (err) {
    const message = mcpErrorMessage(err);
    return c.json({ error: message.startsWith("The server turned") ? "The server turned that token down" : message }, 400);
  }
  saveCredential(s.id, user.id, { kind: "token", headers });
  forgetPerson(s.id, user.id);
  return c.json({ connection: connectionOut(s, user.id) });
});

/** Forgets a person's own account on a server (and asks its sign-in service to withdraw what it issued). */
connectionRoutes.delete("/mcp/connections/:id", requireUser, (c) => {
  const user = c.var.user!;
  const id = Number(c.req.param("id"));
  disconnect(id, user.id);
  const s = getServer(id);
  return c.json({ connection: s && personal(s) ? connectionOut(s, user.id) : null });
});
