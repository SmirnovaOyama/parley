// Admin: groups of people, MCP servers, and the search service behind web search for models
// without their own.
import { Hono } from "hono";
import { requireAdmin, type AppEnv } from "../auth.ts";
import { MAX_DOLLARS } from "../allowance.ts";
import { tx } from "../chat-store.ts";
import { encryptSecret } from "../crypto.ts";
import { audit, db, getSettings, nowIso, saveSearchKey, saveSettings, searchKeySealed, SEARCH_PROVIDERS } from "../db.ts";
import {
  forget,
  getServer,
  headersOf,
  listTools,
  mcpErrorMessage,
  offToolsOf,
  refreshServer,
  runsByDefault,
  runsUnasked,
  toolsOf,
  type McpServerRow,
} from "../mcp.ts";
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
  if (id != null && !existing) return { error: "This group doesn't exist", status: 404 };
  const name = body.name === undefined && existing ? existing.name : String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return { error: "Give the group a name", status: 400 };
  const clash = db.prepare("SELECT id FROM user_groups WHERE name = ? AND id IS NOT ?").get(name, id) as { id: number } | undefined;
  if (clash) return { error: "There's a group with that name already", status: 409 };
  let spend = existing?.spend_limit ?? null;
  if (body.spendLimit !== undefined) {
    if (body.spendLimit === null || body.spendLimit === "") spend = null;
    else {
      const n = Number(String(body.spendLimit).replace(/^\s*\$|[,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0 || n > MAX_DOLLARS) return { error: "Enter the spending limit in dollars, like 5 or 2.50, or leave it empty", status: 400 };
      spend = Math.round(n * 100) / 100;
    }
  }
  const members = knownIds(body.memberIds, "users");
  const keys = knownIds(body.keyIds, "api_keys");
  const servers = knownIds(body.serverIds, "mcp_servers");
  if (!members || !keys || !servers) return { error: "Some of those people, keys or servers don't exist any more", status: 400 };
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
  if (!g) return c.json({ error: "This group doesn't exist" }, 404);
  db.prepare("DELETE FROM user_groups WHERE id = ?").run(g.id);
  audit(c.var.user!.id, "delete_group", g.name);
  return c.json({ ok: true });
});

// ── MCP servers ─────────────────────────────────────────────────────

function serverOut(s: McpServerRow) {
  const headers = headersOf(s);
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
    groupIds: idsOf("SELECT group_id AS v FROM group_mcp WHERE server_id = ?", s.id),
    checkedAt: s.checked_at,
    error: s.error,
  };
}

/** "Authorization: Bearer abc" lines, or a token alone (sent as a bearer token). */
function parseHeaders(raw: unknown): Record<string, string> | { error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && !lines[0].includes(":")) return { Authorization: `Bearer ${lines[0]}` };
  const out: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(":");
    const name = line.slice(0, at).trim();
    if (at < 1 || !/^[A-Za-z0-9-]+$/.test(name)) return { error: "Write each header on its own line, like Authorization: Bearer abc123" };
    out[name] = line.slice(at + 1).trim();
  }
  return out;
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
  return c.json({ servers: rows.map(serverOut) });
});

/** Adds a server once it answers: its tools are listed and kept. */
adminToolRoutes.post("/mcp", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) return c.json({ error: "Give the server a name, like GitHub" }, 400);
  const url = parseServerUrl(body.url);
  if (!url) return c.json({ error: "Type the server's address, starting with https://" }, 400);
  const headers = parseHeaders(body.headers);
  if ("error" in headers) return c.json(headers, 400);
  let tools;
  try {
    tools = await listTools(url, headers);
  } catch (err) {
    return c.json({ error: mcpErrorMessage(err) }, 400);
  }
  const groups: number[] = Array.isArray(body.groupIds) ? body.groupIds.map(Number) : [];
  const id = Number(
    db
      .prepare(
        "INSERT INTO mcp_servers (name, url, encrypted_headers, enabled, shared, tools, off_tools, send_user, checked_at, created_at) VALUES (?, ?, ?, 1, ?, ?, '[]', ?, ?, ?)",
      )
      .run(
        name, url, Object.keys(headers).length ? encryptSecret(JSON.stringify(headers)) : null, body.shared === false ? 0 : 1, JSON.stringify(tools),
        body.sendUser ? 1 : 0, nowIso(), nowIso(),
      )
      .lastInsertRowid,
  );
  setServerGroups(id, groups);
  audit(c.var.user!.id, "add_mcp", name);
  return c.json({ server: serverOut(getServer(id)!) });
});

function setServerGroups(id: number, groups: number[]) {
  const known = new Set((db.prepare("SELECT id FROM user_groups").all() as { id: number }[]).map((g) => g.id));
  db.prepare("DELETE FROM group_mcp WHERE server_id = ?").run(id);
  const add = db.prepare("INSERT INTO group_mcp (group_id, server_id) VALUES (?, ?)");
  for (const g of groups) if (known.has(g)) add.run(g, id);
}

/**
 * What an admin chose about each tool running unasked, kept only where it differs from what the
 * server says (a tool it calls read-only runs; any other asks). So a tool whose description
 * changes when the server is asked again follows what it says now, where no admin chose otherwise.
 */
function modesFor(tools: ReturnType<typeof toolsOf>, runTools: string[]): Record<string, "run" | "ask"> {
  const run = new Set(runTools);
  const modes: Record<string, "run" | "ask"> = {};
  for (const t of tools) if (run.has(t.name) !== runsByDefault(t)) modes[t.name] = run.has(t.name) ? "run" : "ask";
  return modes;
}

/** Changes a server. A new address or headers is checked before it's kept. */
adminToolRoutes.patch("/mcp/:id", async (c) => {
  const s = getServer(Number(c.req.param("id")));
  if (!s) return c.json({ error: "This server doesn't exist" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const name = body.name === undefined ? s.name : String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) return c.json({ error: "Give the server a name" }, 400);
  const url = body.url === undefined ? s.url : parseServerUrl(body.url);
  if (!url) return c.json({ error: "Type the server's address, starting with https://" }, 400);
  // Headers left out (or empty with keepHeaders) stay as they are.
  let sealed = s.encrypted_headers;
  if (body.headers !== undefined && !(body.keepHeaders && !String(body.headers).trim())) {
    const headers = parseHeaders(body.headers);
    if ("error" in headers) return c.json(headers, 400);
    sealed = Object.keys(headers).length ? encryptSecret(JSON.stringify(headers)) : null;
  }
  let tools = s.tools;
  let error = s.error;
  if (url !== s.url || sealed !== s.encrypted_headers) {
    try {
      tools = JSON.stringify(await listTools(url, sealed ? headersOf({ encrypted_headers: sealed }) : {}));
      error = null;
    } catch (err) {
      return c.json({ error: mcpErrorMessage(err) }, 400);
    }
  }
  const offTools = Array.isArray(body.offTools) ? JSON.stringify([...new Set(body.offTools.map(String))]) : s.off_tools;
  const toolModes = Array.isArray(body.runTools) ? JSON.stringify(modesFor(toolsOf({ tools }), body.runTools.map(String))) : s.tool_modes;
  const enabled = body.enabled === undefined ? s.enabled : body.enabled ? 1 : 0;
  const shared = body.shared === undefined ? s.shared : body.shared ? 1 : 0;
  const sendUser = body.sendUser === undefined ? s.send_user : body.sendUser ? 1 : 0;
  db.prepare(
    "UPDATE mcp_servers SET name = ?, url = ?, encrypted_headers = ?, tools = ?, off_tools = ?, tool_modes = ?, enabled = ?, shared = ?, send_user = ?, error = ?, checked_at = ? WHERE id = ?",
  ).run(name, url, sealed, tools, offTools, toolModes, enabled, shared, sendUser, error, nowIso(), s.id);
  if (Array.isArray(body.groupIds)) setServerGroups(s.id, body.groupIds.map(Number));
  forget(s.id);
  audit(c.var.user!.id, "edit_mcp", name);
  return c.json({ server: serverOut(getServer(s.id)!) });
});

/** Asks the server for its tools again (new ones join new chats). */
adminToolRoutes.post("/mcp/:id/refresh", async (c) => {
  const s = getServer(Number(c.req.param("id")));
  if (!s) return c.json({ error: "This server doesn't exist" }, 404);
  return c.json({ server: serverOut(await refreshServer(s)) });
});

adminToolRoutes.delete("/mcp/:id", (c) => {
  const s = getServer(Number(c.req.param("id")));
  if (!s) return c.json({ error: "This server doesn't exist" }, 404);
  db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(s.id);
  forget(s.id);
  audit(c.var.user!.id, "delete_mcp", s.name);
  return c.json({ ok: true });
});

// ── Web search for models without their own ──────────────────────────

function searchOut() {
  const s = getSettings();
  return { provider: s.searchProvider, url: s.searchUrl, hasKey: !!searchKeySealed(), services: SEARCH_SERVICES };
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
  if (!provider) return c.json({ error: "Choose a search service" }, 400);
  const service = SEARCH_SERVICES.find((s) => s.id === provider)!;
  const before = { provider: getSettings().searchProvider, url: getSettings().searchUrl, key: searchKeySealed() };
  if (service.needs === "url") {
    const url = parseServerUrl(body.url);
    if (!url) return c.json({ error: "Type your SearXNG's address, starting with https://" }, 400);
    saveSettings({ searchProvider: provider, searchUrl: url.replace(/\/+$/, "") });
  } else {
    const key = String(body.key ?? "").trim();
    if (!key && (!before.key || before.provider !== provider)) return c.json({ error: `Paste the ${service.label} API key` }, 400);
    saveSettings({ searchProvider: provider });
    if (key) saveSearchKey(encryptSecret(key));
  }
  // A search proves it works; if it doesn't, everything goes back as it was.
  try {
    await webSearch("weather");
  } catch (err) {
    saveSettings({ searchProvider: before.provider, searchUrl: before.url });
    saveSearchKey(before.key);
    return c.json({ error: (err as Error).message || "The search service didn't answer" }, 400);
  }
  audit(c.var.user!.id, "edit_search", service.label);
  return c.json(searchOut());
});
