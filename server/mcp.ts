// MCP servers an admin connects (Streamable HTTP, or the older HTTP+SSE). Their tools join new chats
// of the people allowed to use them, under names made from the server's and the tool's. Each person
// gets a connection (and MCP session) of their own, so a server that keeps state between calls
// keeps it per person; connections stay open while in use and close after a few idle minutes.
// Whose account the calls act with is the server's auth_mode: on a shared server everyone calls
// with the headers the admin gave, so the server acts for all of them alike; on the others each
// person calls with their own account, or not at all (mcp-auth.ts).
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decryptSecret } from "./crypto.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";
import {
  AccountError,
  accountErrorIn,
  dropCredentials,
  markUsed,
  personal,
  personalCredential,
  refreshed,
  rejected,
  type AccountState,
} from "./mcp-auth.ts";
import type { ToolOutcome, ToolSpec } from "./providers/types.ts";

export type McpServerRow = {
  id: number;
  name: string;
  url: string;
  encrypted_headers: string | null;
  enabled: number;
  shared: number;
  tools: string;
  off_tools: string;
  /** JSON { tool: "run" | "ask" } where an admin chose differently from what the server says of it (see runsUnasked). */
  tool_modes: string;
  /** 1: every request says who's asking, in an X-Parley-User header with the person's email. */
  send_user: number;
  /** Whose account calls act with (mcp-auth.ts): "shared", "oauth" or "token". */
  auth_mode: string;
  /** For "token": what an admin tells people to paste. */
  token_hint: string | null;
  /** For "oauth": a client an admin registered (encrypted), and the one Parley registered itself (encrypted). */
  oauth_client: string | null;
  oauth_registration: string | null;
  checked_at: string | null;
  error: string | null;
  created_at: string;
};

/** What a server says a tool does (MCP's annotations). Hints only: they're the server's word. */
export type ToolHints = { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };

/** A tool as the server described it. */
export type McpTool = { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: ToolHints };

const IDLE_MS = 5 * 60_000;
/** Open connections at most, across servers and people; the one idle longest closes first. */
const MAX_OPEN = 200;
/** The header that names the person, on servers set to say who's asking. */
export const USER_HEADER = "X-Parley-User";
const CALL_TIMEOUT_MS = 90_000;
/** What a tool returns is cut here, so one call can't flood the chat. */
const MAX_RESULT_CHARS = 60_000;

export function getServer(id: number): McpServerRow | undefined {
  return db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerRow | undefined;
}

export function headersOf(s: Pick<McpServerRow, "encrypted_headers">): Record<string, string> {
  if (!s.encrypted_headers) return {};
  try {
    return JSON.parse(decryptSecret(s.encrypted_headers)) as Record<string, string>;
  } catch {
    return {};
  }
}

/** "Authorization: Bearer abc" lines, or a token alone (sent as a bearer token). */
export function parseHeaders(raw: unknown): Record<string, string> | { error: string } {
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

export const toolsOf = (s: Pick<McpServerRow, "tools">): McpTool[] => {
  try {
    return JSON.parse(s.tools) as McpTool[];
  } catch {
    return [];
  }
};
export const offToolsOf = (s: Pick<McpServerRow, "off_tools">): string[] => {
  try {
    return JSON.parse(s.off_tools) as string[];
  } catch {
    return [];
  }
};
export const toolModesOf = (s: Pick<McpServerRow, "tool_modes">): Record<string, "run" | "ask"> => {
  try {
    const modes = JSON.parse(s.tool_modes);
    return modes && typeof modes === "object" && !Array.isArray(modes) ? modes : {};
  } catch {
    return {};
  }
};

/**
 * Whether a tool runs as soon as the model calls it, unless an admin chose: when the server says
 * it only reads, and doesn't say it reaches services beyond the server. One that does (fetching
 * any address, say) could still carry what the chat holds somewhere else, so it asks.
 */
export const runsByDefault = (t: Pick<McpTool, "annotations"> | undefined) => t?.annotations?.readOnlyHint === true && t.annotations.openWorldHint !== true;

/**
 * Whether a tool runs without asking the person first: as an admin set it, else as runsByDefault
 * says. Everything else (and every tool of a server that says nothing) asks.
 */
export function runsUnasked(s: Pick<McpServerRow, "tools" | "tool_modes">, tool: string): boolean {
  const mode = toolModesOf(s)[tool];
  return mode ? mode === "run" : runsByDefault(toolsOf(s).find((t) => t.name === tool));
}

/** Connections by server and person ("3:12"). */
type Open = { client: Client; fingerprint: string; lastUsed: number };
const open = new Map<string, Open>();
const openKey = (serverId: number, userId: number) => `${serverId}:${userId}`;

function close(key: string) {
  const known = open.get(key);
  open.delete(key);
  if (known) void known.client.close().catch(() => {});
}

setInterval(() => {
  for (const [key, o] of open) if (Date.now() - o.lastUsed > IDLE_MS) close(key);
}, 60_000).unref();

/** How many connections are open now (for tests). */
export const openConnections = () => open.size;

/** Connects to a server: Streamable HTTP first, then the older SSE transport. */
async function connect(url: string, fetchFn: typeof fetch): Promise<Client> {
  const info = { name: env.appName, version: "1.0.0" };
  const client = new Client(info);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: fetchFn }));
    return client;
  } catch (first) {
    // Without the person's account, the other transport wouldn't get further.
    if (accountErrorIn(first)) throw first;
    const fallback = new Client(info);
    try {
      await fallback.connect(new SSEClientTransport(new URL(url), { fetch: fetchFn }));
      return fallback;
    } catch {
      throw first;
    }
  }
}

/** The header naming the person, for a server set to say who's asking. An address that isn't plain ASCII goes percent-encoded. */
function whoIsAsking(s: Pick<McpServerRow, "send_user">, userId: number): Record<string, string> {
  if (!s.send_user) return {};
  const row = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined;
  if (!row) return {};
  return { [USER_HEADER]: /^[\x21-\x7e]+$/.test(row.email) ? row.email : encodeURIComponent(row.email) };
}

/**
 * A request's headers: the credential's first, then the transport's own (its session and
 * protocol), which a credential can't replace, then who's asking, which nothing can.
 */
function headersFor(credential: Record<string, string>, transport: RequestInit["headers"], who: Record<string, string>): Headers {
  const headers = new Headers(credential);
  for (const [name, value] of new Headers(transport)) headers.set(name, value);
  for (const [name, value] of Object.entries(who)) headers.set(name, value);
  return headers;
}

/** fetch whose every request carries these headers (an admin's, or ones being tried out). */
export const fetchWithHeaders =
  (headers: Record<string, string>, who: Record<string, string> = {}): typeof fetch =>
  (input, init) =>
    fetch(input, { ...init, headers: headersFor(headers, init?.headers, who) });

/**
 * fetch for a person's requests to a server: on a shared server, with the admin's headers; on the
 * others, with the person's own account. A pasted token the server turns down, or a sign-in it
 * still turns down once refreshed, is marked as needing connecting again.
 */
function fetchFor(s: McpServerRow, userId: number): typeof fetch {
  const who = whoIsAsking(s, userId);
  if (!personal(s)) return fetchWithHeaders(headersOf(s), who);
  return async (input, init) => {
    const own = await personalCredential(s, userId);
    let res = await fetch(input, { ...init, headers: headersFor(own.headers, init?.headers, who) });
    if (res.status !== 401) return res;
    await res.body?.cancel();
    if (!own.accessToken) throw rejected(s, userId, own.connectedAt);
    const fresh = await refreshed(s, userId, own.accessToken);
    res = await fetch(input, { ...init, headers: headersFor({ Authorization: `Bearer ${fresh}` }, init?.headers, who) });
    if (res.status !== 401) return res;
    await res.body?.cancel();
    throw rejected(s, userId, own.connectedAt);
  };
}

/** This person's connection to the server, opened when there's none (or the server's details changed). */
async function clientFor(s: McpServerRow, userId: number): Promise<Client> {
  // A server that wants the person's own account isn't even reached without it.
  const own = personal(s) ? (db.prepare("SELECT status, connected_at FROM mcp_credentials WHERE server_id = ? AND user_id = ?").get(s.id, userId) as { status: string; connected_at: string } | undefined) : undefined;
  if (personal(s) && own?.status !== "ok") throw new AccountError(own ? "expired" : "missing");
  // A new sign-in or token makes a new connection, so a session never outlives the account it began on.
  const credential = personal(s) ? `${s.auth_mode} ${own!.connected_at}` : JSON.stringify(headersOf(s));
  const fingerprint = createHash("sha256").update(`${s.url}\n${credential}\n${JSON.stringify(whoIsAsking(s, userId))}`).digest("hex");
  const key = openKey(s.id, userId);
  const known = open.get(key);
  if (known && known.fingerprint === fingerprint) {
    known.lastUsed = Date.now();
    return known.client;
  }
  if (known) close(key);
  const client = await connect(s.url, fetchFor(s, userId));
  // Room for it: the connection idle longest goes.
  while (open.size >= MAX_OPEN) {
    let oldest: string | null = null;
    for (const [k, o] of open) if (!oldest || o.lastUsed < open.get(oldest)!.lastUsed) oldest = k;
    close(oldest!);
  }
  open.set(key, { client, fingerprint, lastUsed: Date.now() });
  return client;
}

/** Drops a server's open connections, everyone's (after it's changed or deleted). */
export function forget(id: number) {
  for (const key of [...open.keys()]) if (key.startsWith(`${id}:`)) close(key);
}

/** Drops one person's connection to a server (their account on it changed). */
export const forgetPerson = (serverId: number, userId: number) => close(openKey(serverId, userId));

/** Forgets a person's own account on a server, and the connection it made. */
export function disconnect(serverId: number, userId: number) {
  dropCredentials({ server: serverId, user: userId });
  forgetPerson(serverId, userId);
}

/** Forgets everyone's own accounts on a server (its address or way of signing in changed, or it's going). */
export function disconnectEveryone(serverId: number) {
  dropCredentials({ server: serverId });
  forget(serverId);
}

/** Forgets the accounts nobody may use any more, after people, groups or servers change (mcp-auth.ts, dropCredentials). */
export function sweepCredentials() {
  for (const { serverId, userId } of dropCredentials("unusable")) forgetPerson(serverId, userId);
}

/** A sentence for a server that couldn't be reached or listed. */
export function mcpErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  if (code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) return "The server turned the request down. Check its token";
  if (code === 404 || code === 405 || /\b404\b/.test(message)) return "Nothing answered at that address. Check the URL, which usually ends in /mcp";
  if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|fetch failed|timed? ?out/i.test(message)) return "Couldn't reach the server. Check the address and that it's running";
  return `The server answered with an error: ${message.slice(0, 200)}`;
}

/** The hints a server gave about a tool, the yes-or-no ones only. */
function hintsOf(annotations: unknown): { annotations?: ToolHints } {
  if (!annotations || typeof annotations !== "object") return {};
  const hints: ToolHints = {};
  for (const name of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
    const value = (annotations as Record<string, unknown>)[name];
    if (typeof value === "boolean") hints[name] = value;
  }
  return Object.keys(hints).length ? { annotations: hints } : {};
}

/** Lists a server's tools, every page of them, with these headers on every request (or through this fetch). */
export async function listTools(url: string, headers: Record<string, string> | typeof fetch): Promise<McpTool[]> {
  const client = await connect(url, typeof headers === "function" ? headers : fetchWithHeaders(headers));
  try {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
          ...hintsOf(t.annotations),
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  } finally {
    void client.close().catch(() => {});
  }
}

/**
 * Lists a saved server's tools again and keeps what it said (or why it couldn't). A shared server
 * is asked with the admin's headers; the others with the asking admin's own account.
 */
export async function refreshServer(s: McpServerRow, adminId: number): Promise<McpServerRow> {
  try {
    const tools = await listTools(s.url, fetchFor(s, adminId));
    db.prepare("UPDATE mcp_servers SET tools = ?, checked_at = ?, error = NULL WHERE id = ?").run(JSON.stringify(tools), nowIso(), s.id);
  } catch (err) {
    const account = accountErrorIn(err);
    const error = !account
      ? mcpErrorMessage(err)
      : s.auth_mode === "oauth"
        ? "Sign in to it with your own account first, so it can list its tools"
        : account.reason === "missing"
          ? "Add a token of your own first, so it can list its tools"
          : "The server turned your token down. Add a new one, so it can list its tools";
    db.prepare("UPDATE mcp_servers SET checked_at = ?, error = ? WHERE id = ?").run(nowIso(), error, s.id);
  }
  forget(s.id);
  return getServer(s.id)!;
}

/** The servers whose tools this person's new chats get: on, and open to everyone or to a group they're in. */
export function serversFor(userId: number): McpServerRow[] {
  return db
    .prepare(
      `SELECT * FROM mcp_servers s WHERE s.enabled = 1 AND (s.shared = 1 OR s.id IN (
         SELECT gm2.server_id FROM group_mcp gm2 JOIN group_members m ON m.group_id = gm2.group_id WHERE m.user_id = ?))
       ORDER BY s.id`,
    )
    .all(userId) as McpServerRow[];
}

export const canUseServer = (s: McpServerRow | undefined, userId: number) => !!s && serversFor(userId).some((x) => x.id === s.id);

/** A name a model takes: letters, digits, _ and -, up to 64 long. */
export function toolName(server: string, tool: string): string {
  const clean = (t: string) => t.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const name = `${clean(server).toLowerCase() || "mcp"}__${clean(tool) || "tool"}`;
  if (name.length <= 64) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return `${name.slice(0, 57)}_${hash}`;
}

/** A tool's input schema as every provider takes it: an object at the top. */
function schemaOf(t: McpTool): Record<string, unknown> {
  const schema = { ...(t.inputSchema ?? {}) };
  if (schema.type !== "object") return { type: "object", properties: {} };
  if (!schema.properties) schema.properties = {};
  delete schema.$schema;
  return schema;
}

export type McpDeclared = ToolSpec & { mcp: { server: number; tool: string } };

/** The tools a new chat declares from these servers, each named after its server. */
export function declareTools(servers: McpServerRow[]): McpDeclared[] {
  const out: McpDeclared[] = [];
  const used = new Set<string>();
  for (const s of servers) {
    const off = new Set(offToolsOf(s));
    for (const t of toolsOf(s)) {
      if (off.has(t.name)) continue;
      let name = toolName(s.name, t.name);
      if (used.has(name)) name = toolName(`${s.name}${s.id}`, t.name);
      used.add(name);
      const about = [t.title && t.title !== t.name ? t.title : "", t.description ?? ""].filter(Boolean).join(". ");
      out.push({ name, description: `${about || t.name} (from ${s.name})`.slice(0, 1024), parameters: schemaOf(t), mcp: { server: s.id, tool: t.name } });
    }
  }
  return out;
}

type ContentItem = { type: string; text?: string; mimeType?: string; uri?: string; resource?: { uri?: string; text?: string; mimeType?: string }; name?: string };

/** What a call returned, as text for the model. */
function resultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  for (const item of (Array.isArray(result.content) ? result.content : []) as ContentItem[]) {
    if (item.type === "text" && item.text) parts.push(item.text);
    else if (item.type === "image" || item.type === "audio") parts.push(`(${item.type === "image" ? "An image" : "Audio"}, ${item.mimeType ?? "unknown type"}, that can't be shown here.)`);
    else if (item.type === "resource" && item.resource) parts.push(item.resource.text ?? `(A resource at ${item.resource.uri ?? "an unknown address"}.)`);
    else if (item.type === "resource_link") parts.push(`(A link to ${item.name ?? item.uri}: ${item.uri}.)`);
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  const text = parts.join("\n\n");
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n(The result goes on; this is its first part.)` : text;
}

/** What the model is told when a call needs the person's own account first. */
export function accountMessage(s: Pick<McpServerRow, "name" | "auth_mode">, state: AccountState): string {
  const how = "They can connect it in Account, under Connected services, and then ask you again";
  if (state === "missing") return `${s.name} acts with each person's own account, and this person hasn't connected theirs, so this didn't run. ${how}`;
  return `This person's ${s.auth_mode === "token" ? "token" : "sign-in"} for ${s.name} has stopped working (it ran out or was withdrawn), so this didn't run. ${how}`;
}

/**
 * Calls a server's tool for this person, on their connection. Never throws: a failure comes back
 * as an error for the model, and `account` says when it was the person's own account that's missing.
 */
export async function callTool(
  s: McpServerRow,
  userId: number,
  tool: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolOutcome & { account?: AccountState }> {
  const key = openKey(s.id, userId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const reused = open.has(key);
    try {
      const client = await clientFor(s, userId);
      const result = (await client.callTool({ name: tool, arguments: input }, undefined, { signal, timeout: CALL_TIMEOUT_MS })) as {
        content?: unknown;
        structuredContent?: unknown;
        toolResult?: unknown;
        isError?: boolean;
      };
      if (personal(s)) markUsed(s.id, userId);
      // Servers from before structured results answer with toolResult.
      if (result.content === undefined && result.toolResult !== undefined) return { content: JSON.stringify(result.toolResult, null, 2) };
      return { content: resultText(result), isError: !!result.isError };
    } catch (err) {
      close(key);
      if (signal.aborted) return { content: "Stopped", isError: true };
      const account = accountErrorIn(err);
      if (account) return { content: accountMessage(s, account.reason), isError: true, account: account.reason };
      // A connection kept from earlier that the server has since dropped (it restarted, say) is
      // opened again once. The call never reached the tool, so nothing runs twice.
      if (attempt === 0 && reused && /session|not connected|closed|404/i.test(String((err as Error)?.message))) continue;
      console.error(`[mcp] ${s.name} ${tool} failed:`, err);
      return { content: mcpErrorMessage(err), isError: true };
    }
  }
  return { content: "The tool couldn't be reached", isError: true };
}
