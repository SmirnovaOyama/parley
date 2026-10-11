// Admin: groups of people, MCP servers, and the search service behind web search for models
// without their own.
import { Hono, type Context } from "hono";
import { originOf, requireAdmin, type AppEnv } from "../auth.ts";
import { MAX_DOLLARS } from "../allowance.ts";
import { tx } from "../chat-store.ts";
import { encryptSecret } from "../crypto.ts";
import { audit, db, getSettings, nowIso, saveSearchKey, saveSettings, searchKeySealed, SEARCH_PROVIDERS } from "../db.ts";
import { t } from "../i18n.ts";
import {
  disconnectEveryone,
  fetchWithHeaders,
  forget,
  getServer,
  headersOf,
  keptListing,
  listingChanges,
  listingVersion,
  listTools,
  mcpErrorMessage,
  offToolsOf,
  parseHeaders,
  refreshServer,
  runsByDefault,
  runsUnasked,
  settleListing,
  sweepCredentials,
  toolsOf,
  type McpServerRow,
  type McpTool,
} from "../mcp.ts";
import { accountState, adminClient, AUTH_MODES, callbackUrl, ownHeaders, personal, saveCredential, type AuthMode } from "../mcp-auth.ts";
import { SEARCH_SERVICES, webSearch } from "../web-tools.ts";

export const adminToolRoutes = new Hono<AppEnv>();
adminToolRoutes.use("*", requireAdmin);

// ── Groups ──────────────────────────────────────────────────────────

type GroupRow = { id: number; name: string; spend_limit: number | null; created_at: string };

const idsOf = (sql: string, id: number) => (db.prepare(sql).all(id) as { v: number }[]).map((r) => r.v);

function groupOut(g: GroupRow) {
  return {
    id: g.id,
    name: g.name,
    spendLimit: g.spend_limit,
    memberIds: idsOf("SELECT user_id AS v FROM group_members WHERE group_id = ?", g.id),
    keyIds: idsOf("SELECT api_key_id AS v FROM group_keys WHERE group_id = ?", g.id),
    serverIds: idsOf("SELECT server_id AS v FROM group_mcp WHERE group_id = ?", g.id),
  };
}

adminToolRoutes.get("/groups", (c) => {
  const rows = db.prepare("SELECT * FROM user_groups ORDER BY lower(name)").all() as GroupRow[];
  return c.json({ groups: rows.map(groupOut) });
});

/** Ids from a form that exist in a table, or null when one doesn't. */
function knownIds(value: unknown, table: "users" | "api_keys" | "mcp_servers"): number[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map(Number))];
  const known = new Set((db.prepare(`SELECT id FROM ${table}`).all() as { id: number }[]).map((r) => r.id));
  return ids.every((id) => known.has(id)) ? ids : null;
}

/** Saves a group (new when id is null): its name, its members' limit, who's in it, and what it opens. */
function saveGroup(id: number | null, body: Record<string, unknown>, adminId: number): { group: ReturnType<typeof groupOut> } | { error: string; status: 400 | 404 | 409 } {
  const existing = id == null ? undefined : (db.prepare("SELECT * FROM user_groups WHERE id = ?").get(id) as GroupRow | undefined);
  if (id != null && !existing) return { error: t("This group doesn't exist"), status: 404 };
  const name = body.name === undefined && existing ? existing.name : String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return { error: t("Give the group a name"), status: 400 };
  const clash = db.prepare("SELECT id FROM user_groups WHERE name = ? AND id IS NOT ?").get(name, id) as { id: number } | undefined;
  if (clash) return { error: t("There's a group with that name already"), status: 409 };
  let spend = existing?.spend_limit ?? null;
  if (body.spendLimit !== undefined) {
    if (body.spendLimit === null || body.spendLimit === "") spend = null;
    else {
      const n = Number(String(body.spendLimit).replace(/^\s*\$|[,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0 || n > MAX_DOLLARS) return { error: t("Enter the spending limit in dollars, like 5 or 2.50, or leave it empty"), status: 400 };
      spend = Math.round(n * 100) / 100;
    }
  }
  const members = knownIds(body.memberIds, "users");
  const keys = knownIds(body.keyIds, "api_keys");
  const servers = knownIds(body.serverIds, "mcp_servers");
  if (!members || !keys || !servers) return { error: t("Some of those people, keys or servers don't exist any more"), status: 400 };
  const groupId = tx(() => {
    let gid = id;
    if (gid == null) {
      gid = Number(db.prepare("INSERT INTO user_groups (name, spend_limit, created_at) VALUES (?, ?, ?)").run(name, spend, nowIso()).lastInsertRowid);
    } else {
      db.prepare("UPDATE user_groups SET name = ?, spend_limit = ? WHERE id = ?").run(name, spend, gid);
    }
    const replace = (table: string, column: string, list: number[], given: unknown) => {
      if (given === undefined) return;
      db.prepare(`DELETE FROM ${table} WHERE group_id = ?`).run(gid);
      const add = db.prepare(`INSERT INTO ${table} (group_id, ${column}) VALUES (?, ?)`);
      for (const v of list) add.run(gid, v);
    };
    replace("group_members", "user_id", members, body.memberIds);
    replace("group_keys", "api_key_id", keys, body.keyIds);
    replace("group_mcp", "server_id", servers, body.serverIds);
    return gid!;
  });
  // Someone who left a group may have lost a server their own account was connected to.
  sweepCredentials();
  audit(adminId, id == null ? "add_group" : "edit_group", name);
  return { group: groupOut(db.prepare("SELECT * FROM user_groups WHERE id = ?").get(groupId) as GroupRow) };
}

adminToolRoutes.post("/groups", async (c) => {
  const saved = saveGroup(null, await c.req.json().catch(() => ({})), c.var.user!.id);
  return "error" in saved ? c.json({ error: saved.error }, saved.status) : c.json(saved);
});

adminToolRoutes.patch("/groups/:id", async (c) => {
  const saved = saveGroup(Number(c.req.param("id")), await c.req.json().catch(() => ({})), c.var.user!.id);
  return "error" in saved ? c.json({ error: saved.error }, saved.status) : c.json(saved);
});

adminToolRoutes.delete("/groups/:id", (c) => {
  const g = db.prepare("SELECT * FROM user_groups WHERE id = ?").get(Number(c.req.param("id"))) as GroupRow | undefined;
  if (!g) return c.json({ error: t("This group doesn't exist") }, 404);
  db.prepare("DELETE FROM user_groups WHERE id = ?").run(g.id);
  sweepCredentials();
  audit(c.var.user!.id, "delete_group", g.name);
  return c.json({ ok: true });
});

// ── MCP servers ─────────────────────────────────────────────────────

/** A tool as an admin compares it: what the model reads, what the server says it does, and whether it would ask. */
function toolText(t: McpTool, runs: boolean) {
  return {
    title: t.title ?? null,
    description: t.description ?? "",
    input: JSON.stringify(t.inputSchema ?? {}, null, 2),
    readOnly: t.annotations?.readOnlyHint ?? null,
    destructive: t.annotations?.destructiveHint ?? null,
    openWorld: t.annotations?.openWorldHint ?? null,
    runs,
  };
}

/** Tools the server listed that wait for an admin, each beside the one kept, with a version to take them by. */
function pendingOut(s: McpServerRow) {
  if (!s.pending_tools) return null;
  const waiting = { tools: s.pending_tools, tool_modes: s.tool_modes };
  return {
    version: listingVersion(s.pending_tools),
    changes: listingChanges(toolsOf(s), toolsOf(waiting)).map((c) => ({
      name: c.name,
      change: c.change,
      parts: c.parts,
      before: c.before && toolText(c.before, runsUnasked(s, c.name)),
      after: c.after && toolText(c.after, runsUnasked(waiting, c.name)),
    })),
  };
}

/** Who has connected their own account to a server, and how it stands: never what with. */
function peopleOn(serverId: number) {
  const rows = db
    .prepare(
      `SELECT u.email, c.status, c.connected_at, c.used_at FROM mcp_credentials c JOIN users u ON u.id = c.user_id
       WHERE c.server_id = ? ORDER BY lower(u.email)`,
    )
    .all(serverId) as { email: string; status: string; connected_at: string; used_at: string | null }[];
  return rows.map((r) => ({ email: r.email, status: r.status === "ok" ? "connected" : "expired", connectedAt: r.connected_at, usedAt: r.used_at }));
}

/** A server as the admin pages show it, to this admin, who reached the site at `origin`. */
function serverOut(s: McpServerRow, viewer: { id: number; origin: string }) {
  const headers = headersOf(s);
  const client = adminClient(s);
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    /** Header names only: their values are secrets and never come back. */
    headerNames: Object.keys(headers),
    enabled: !!s.enabled,
    shared: !!s.shared,
    // What the server says of each tool (null: it doesn't say), shown beside the choice to let it run unasked.
    tools: toolsOf(s).map((t) => ({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? "",
      readOnly: t.annotations?.readOnlyHint ?? null,
      openWorld: t.annotations?.openWorldHint ?? null,
    })),
    offTools: offToolsOf(s),
    /** The tools that run as soon as the model calls them; the rest ask the person first. */
    runTools: toolsOf(s).filter((t) => runsUnasked(s, t.name)).map((t) => t.name),
    sendUser: !!s.send_user,
    /** Whose account calls act with: shared (the headers), or each person's own, signed in (oauth) or pasted (token). */
    authMode: s.auth_mode as AuthMode,
    tokenHint: s.token_hint ?? "",
    /** A client an admin registered with the server's sign-in service: its ID, and whether it has a secret (never shown). */
    clientId: client?.client_id ?? "",
    hasClientSecret: !!client?.client_secret,
    /** The address to register as its callback, where the sign-in service needs one registering. */
    callbackUrl: callbackUrl(viewer.origin),
    /** On each person's own account: who has connected theirs. */
    people: personal(s) ? peopleOn(s.id) : [],
    /** On each person's own account: where this admin's own stands (it's what lists the tools). */
    yours: personal(s) ? (accountState(s, viewer.id) ?? "connected") : null,
    groupIds: idsOf("SELECT group_id AS v FROM group_mcp WHERE server_id = ?", s.id),
    checkedAt: s.checked_at,
    error: s.error,
    /** New or changed tools from the last listing, which new chats don't get until an admin takes them. */
    pending: pendingOut(s),
  };
}

const viewerOf = (c: Context<AppEnv>) => ({ id: c.var.user!.id, origin: originOf(c) });

/** The way of signing in a form chose (undefined: it didn't say; null: not one there is). */
function modeOf(raw: unknown): AuthMode | null | undefined {
  if (raw === undefined) return undefined;
  return AUTH_MODES.find((m) => m === raw) ?? null;
}

/**
 * The client an admin registered with a server's sign-in service, sealed for keeping: a new ID
 * (with its secret), the one kept (an empty secret keeps the saved one while the ID stays), or none.
 */
function clientFrom(body: Record<string, unknown>, before: McpServerRow | null): string | null | { error: string } {
  if (body.clientId === undefined) return before?.oauth_client ?? null;
  const id = String(body.clientId ?? "").trim();
  if (!id) return null;
  if (id.length > 500) return { error: t("That client ID is too long") };
  const kept = before ? adminClient(before) : null;
  const secret = String(body.clientSecret ?? "").trim() || (kept?.client_id === id ? kept.client_secret : undefined);
  if (secret && secret.length > 2000) return { error: t("That client secret is too long") };
  return encryptSecret(JSON.stringify(secret ? { client_id: id, client_secret: secret } : { client_id: id }));
}

const hintFrom = (raw: unknown) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;

/** The admin's own token for a server on pasted tokens, from a form: null when none was given. */
function ownTokenFrom(raw: unknown): Record<string, string> | null | { error: string } {
  const headers = parseHeaders(raw);
  if ("error" in headers) return { error: headers.error as string };
  return Object.keys(ownHeaders(headers)).length ? ownHeaders(headers) : null;
}

function parseServerUrl(raw: unknown): string | null {
  try {
    const url = new URL(String(raw ?? "").trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

adminToolRoutes.get("/mcp", (c) => {
  const rows = db.prepare("SELECT * FROM mcp_servers ORDER BY id").all() as McpServerRow[];
  return c.json({ servers: rows.map((s) => serverOut(s, viewerOf(c))) });
});

/**
 * Adds a server once it answers: its tools are listed and kept straight away, the admin having just
 * chosen it. A shared one is asked with its headers, one on pasted tokens with the admin's own
 * token. One people sign in to waits for the admin to sign in (the form goes on to the server's
 * sign-in page), which lists them then.
 */
adminToolRoutes.post("/mcp", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) return c.json({ error: t("Give the server a name, like GitHub") }, 400);
  const url = parseServerUrl(body.url);
  if (!url) return c.json({ error: t("Type the server's address, starting with https://") }, 400);
  const mode = modeOf(body.authMode) ?? (body.authMode === undefined ? "shared" : null);
  if (!mode) return c.json({ error: t("Choose whose account it uses") }, 400);
  const headers = mode === "shared" ? parseHeaders(body.headers) : {};
  if ("error" in headers) return c.json(headers, 400);
  const own = mode === "token" ? ownTokenFrom(body.ownToken) : null;
  if (own && "error" in own) return c.json(own, 400);
  if (mode === "token" && !own) return c.json({ error: t("Paste a token of your own, so it can list its tools") }, 400);
  const client = mode === "oauth" ? clientFrom(body, null) : null;
  if (client && typeof client === "object") return c.json(client, 400);
  let tools: Awaited<ReturnType<typeof listTools>> = [];
  if (mode !== "oauth") {
    try {
      tools = await listTools(url, own ? fetchWithHeaders(own as Record<string, string>) : (headers as Record<string, string>));
    } catch (err) {
      return c.json({ error: mcpErrorMessage(err) }, 400);
    }
  }
  const groups: number[] = Array.isArray(body.groupIds) ? body.groupIds.map(Number) : [];
  const id = Number(
    db
      .prepare(
        `INSERT INTO mcp_servers (name, url, encrypted_headers, enabled, shared, tools, off_tools, send_user, auth_mode, token_hint, oauth_client, checked_at, created_at)
         VALUES (?, ?, ?, 1, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name, url, Object.keys(headers).length ? encryptSecret(JSON.stringify(headers)) : null, body.shared === false ? 0 : 1, JSON.stringify(tools),
        body.sendUser ? 1 : 0, mode, mode === "token" ? hintFrom(body.tokenHint) : null, client, mode === "oauth" ? null : nowIso(), nowIso(),
      )
      .lastInsertRowid,
  );
  if (own) saveCredential(id, c.var.user!.id, { kind: "token", headers: own as Record<string, string> });
  setServerGroups(id, groups);
  audit(c.var.user!.id, "add_mcp", name);
  return c.json({ server: serverOut(getServer(id)!, viewerOf(c)) });
});

function setServerGroups(id: number, groups: number[]) {
  const known = new Set((db.prepare("SELECT id FROM user_groups").all() as { id: number }[]).map((g) => g.id));
  db.prepare("DELETE FROM group_mcp WHERE server_id = ?").run(id);
  const add = db.prepare("INSERT INTO group_mcp (group_id, server_id) VALUES (?, ?)");
  for (const g of groups) if (known.has(g)) add.run(g, id);
}

/**
 * What an admin chose about each tool running unasked, kept only where it differs from what the
 * server says (a tool it calls read-only runs; any other asks). So once an admin uses a listing in
 * which the server says something new of a tool, the tool follows it, where no admin chose otherwise.
 */
function modesFor(tools: ReturnType<typeof toolsOf>, runTools: string[]): Record<string, "run" | "ask"> {
  const run = new Set(runTools);
  const modes: Record<string, "run" | "ask"> = {};
  for (const t of tools) if (run.has(t.name) !== runsByDefault(t)) modes[t.name] = run.has(t.name) ? "run" : "ask";
  return modes;
}

/**
 * Changes a server. A new address, headers or own token is checked before it's kept. A new
 * address, or a new way of signing in, forgets everyone's own accounts on it: they were for what
 * it was before, so people connect again.
 */
adminToolRoutes.patch("/mcp/:id", async (c) => {
  const s = getServer(Number(c.req.param("id")));
  if (!s) return c.json({ error: t("This server doesn't exist") }, 404);
  const body = await c.req.json().catch(() => ({}));
  const name = body.name === undefined ? s.name : String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) return c.json({ error: t("Give the server a name") }, 400);
  const url = body.url === undefined ? s.url : parseServerUrl(body.url);
  if (!url) return c.json({ error: t("Type the server's address, starting with https://") }, 400);
  const mode = modeOf(body.authMode) ?? (body.authMode === undefined ? (s.auth_mode as AuthMode) : null);
  if (!mode) return c.json({ error: t("Choose whose account it uses") }, 400);
  const reconnect = personal(s) && (mode !== s.auth_mode || url !== s.url);
  // Headers left out (or empty with keepHeaders) stay as they are. Only a shared server keeps any.
  let sealed = mode === "shared" ? s.encrypted_headers : null;
  if (mode === "shared" && body.headers !== undefined && !(body.keepHeaders && !String(body.headers).trim())) {
    const headers = parseHeaders(body.headers);
    if ("error" in headers) return c.json(headers, 400);
    sealed = Object.keys(headers).length ? encryptSecret(JSON.stringify(headers)) : null;
  }
  const own = mode === "token" ? ownTokenFrom(body.ownToken) : null;
  if (own && "error" in own) return c.json(own, 400);
  if (mode === "token" && !own && url !== s.url) return c.json({ error: t("Paste a token of your own for the new address, so it can list its tools") }, 400);
  const client = mode === "oauth" ? clientFrom(body, s) : null;
  if (client && typeof client === "object") return c.json(client, 400);
  // A new address, new headers or a new token of the admin's own may reach a different server, so
  // its tools are listed again. New or changed ones wait for an admin like any other listing; the
  // rest is saved now. One people sign in to is listed when the admin signs in again.
  let listed: McpTool[] | null = null;
  const sharedChanged = mode === "shared" && (s.auth_mode !== "shared" || url !== s.url || sealed !== s.encrypted_headers);
  if (sharedChanged || own) {
    try {
      listed = await listTools(url, own ? fetchWithHeaders(own as Record<string, string>) : sealed ? headersOf({ encrypted_headers: sealed }) : {});
    } catch (err) {
      return c.json({ error: mcpErrorMessage(err) }, 400);
    }
  }
  const now = getServer(s.id);
  if (!now) return c.json({ error: t("This server doesn't exist") }, 404);
  const kept = listed ? keptListing(now, listed) : now;
  const offTools = Array.isArray(body.offTools) ? JSON.stringify([...new Set(body.offTools.map(String))]) : s.off_tools;
  const toolModes = Array.isArray(body.runTools) ? JSON.stringify(modesFor(toolsOf(kept), body.runTools.map(String))) : s.tool_modes;
  const enabled = body.enabled === undefined ? s.enabled : body.enabled ? 1 : 0;
  const shared = body.shared === undefined ? s.shared : body.shared ? 1 : 0;
  const sendUser = body.sendUser === undefined ? s.send_user : body.sendUser ? 1 : 0;
  const hint = mode !== "token" ? null : body.tokenHint === undefined ? s.token_hint : hintFrom(body.tokenHint);
  // Parley's own registration was made for the server's sign-in service as it was.
  const registration = mode === "oauth" && s.auth_mode === "oauth" && url === s.url ? s.oauth_registration : null;
  if (reconnect) disconnectEveryone(s.id);
  db.prepare(
    `UPDATE mcp_servers SET name = ?, url = ?, encrypted_headers = ?, tools = ?, pending_tools = ?, off_tools = ?, tool_modes = ?, enabled = ?, shared = ?, send_user = ?,
       auth_mode = ?, token_hint = ?, oauth_client = ?, oauth_registration = ?, error = ?, checked_at = ? WHERE id = ?`,
  ).run(
    name, url, sealed, kept.tools, kept.pending_tools, offTools, toolModes, enabled, shared, sendUser,
    mode, hint, client, registration, listed ? null : now.error, listed ? nowIso() : now.checked_at, s.id,
  );
  if (own) saveCredential(s.id, c.var.user!.id, { kind: "token", headers: own as Record<string, string> });
  if (Array.isArray(body.groupIds)) setServerGroups(s.id, body.groupIds.map(Number));
  forget(s.id);
  // Shared again, or open to fewer people: accounts nobody may use now are forgotten.
  sweepCredentials();
  audit(c.var.user!.id, "edit_mcp", name);
  return c.json({ server: serverOut(getServer(s.id)!, viewerOf(c)) });
});

/** Asks the server for its tools again. Tools that are new or read differently wait for an admin (pending). */
adminToolRoutes.post("/mcp/:id/refresh", async (c) => {
  const s = getServer(Number(c.req.param("id")));
  if (!s) return c.json({ error: t("This server doesn't exist") }, 404);
  const next = await refreshServer(s, c.var.user!.id);
  if (!next) return c.json({ error: t("This server doesn't exist") }, 404);
  return c.json({ server: serverOut(next, viewerOf(c)) });
});

/**
 * Takes the tools waiting on a server ({ use: true }), so new chats get them, or keeps the old
 * ones ({ use: false }). `version` is the listing the admin looked over; a newer one isn't taken.
 */
adminToolRoutes.post("/mcp/:id/pending", async (c) => {
  const s = getServer(Number(c.req.param("id")));
  if (!s) return c.json({ error: t("This server doesn't exist") }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.use !== "boolean" || typeof body.version !== "string") return c.json({ error: t("Say whether to use the new tools") }, 400);
  const settled = settleListing(s.id, body.version, body.use);
  if (settled === "none") return c.json({ error: t("Nothing from this server is waiting any more") }, 409);
  if (settled === "moved") return c.json({ error: t("The server listed its tools again since this page loaded. Look over what it says now") }, 409);
  audit(c.var.user!.id, body.use ? "take_mcp_tools" : "keep_mcp_tools", s.name);
  return c.json({ server: serverOut(getServer(s.id)!, viewerOf(c)) });
});

/** Forgets everyone's own accounts on a server, so each person connects again. */
adminToolRoutes.post("/mcp/:id/disconnect", (c) => {
  const s = getServer(Number(c.req.param("id")));
  if (!s) return c.json({ error: t("This server doesn't exist") }, 404);
  disconnectEveryone(s.id);
  audit(c.var.user!.id, "disconnect_mcp", s.name);
  return c.json({ server: serverOut(getServer(s.id)!, viewerOf(c)) });
});

adminToolRoutes.delete("/mcp/:id", (c) => {
  const s = getServer(Number(c.req.param("id")));
  if (!s) return c.json({ error: t("This server doesn't exist") }, 404);
  // First, so each sign-in service hears its tokens are done with.
  disconnectEveryone(s.id);
  db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(s.id);
  forget(s.id);
  audit(c.var.user!.id, "delete_mcp", s.name);
  return c.json({ ok: true });
});

// ── Web search for models without their own ──────────────────────────

function searchOut() {
  const s = getSettings();
  return { provider: s.searchProvider, url: s.searchUrl, hasKey: !!searchKeySealed(), services: SEARCH_SERVICES.map((x) => ({ ...x, detail: t(x.detail) })) };
}

adminToolRoutes.get("/search", (c) => c.json(searchOut()));

/** Sets the search service; a new key or address is tried with a search before it's kept. */
adminToolRoutes.put("/search", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.provider === null) {
    saveSettings({ searchProvider: null });
    audit(c.var.user!.id, "edit_search", "Off");
    return c.json(searchOut());
  }
  const provider = SEARCH_PROVIDERS.find((p) => p === body.provider);
  if (!provider) return c.json({ error: t("Choose a search service") }, 400);
  const service = SEARCH_SERVICES.find((s) => s.id === provider)!;
  const before = { provider: getSettings().searchProvider, url: getSettings().searchUrl, key: searchKeySealed() };
  if (service.needs === "url") {
    const url = parseServerUrl(body.url);
    if (!url) return c.json({ error: t("Type your SearXNG's address, starting with https://") }, 400);
    saveSettings({ searchProvider: provider, searchUrl: url.replace(/\/+$/, "") });
  } else {
    const key = String(body.key ?? "").trim();
    if (!key && (!before.key || before.provider !== provider)) return c.json({ error: t("Paste the {label} API key", { label: service.label }) }, 400);
    saveSettings({ searchProvider: provider });
    if (key) saveSearchKey(encryptSecret(key));
  }
  // A search proves it works; if it doesn't, everything goes back as it was.
  try {
    await webSearch("weather");
  } catch (err) {
    saveSettings({ searchProvider: before.provider, searchUrl: before.url });
    saveSearchKey(before.key);
    return c.json({ error: (err as Error).message || t("The search service didn't answer") }, 400);
  }
  audit(c.var.user!.id, "edit_search", service.label);
  return c.json(searchOut());
});
