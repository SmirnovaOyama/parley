// MCP servers an admin connects (Streamable HTTP, or the older HTTP+SSE). Their tools join new chats
// of the people allowed to use them, under names made from the server's and the tool's. Connections
// are kept open while they're in use and closed after a few idle minutes.
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decryptSecret } from "./crypto.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";
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
  checked_at: string | null;
  error: string | null;
  created_at: string;
};

/** A tool as the server described it. */
export type McpTool = { name: string; title?: string; description?: string; inputSchema: Record<string, unknown> };

const IDLE_MS = 5 * 60_000;
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

type Open = { client: Client; fingerprint: string; lastUsed: number };
const open = new Map<number, Open>();

setInterval(() => {
  for (const [id, o] of open) {
    if (Date.now() - o.lastUsed > IDLE_MS) {
      open.delete(id);
      void o.client.close().catch(() => {});
    }
  }
}, 60_000).unref();

/** Connects to a server: Streamable HTTP first, then the older SSE transport. */
async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  // Every request carries the admin's headers (an Authorization token, say).
  const withHeaders: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers } });
  const info = { name: env.appName, version: "1.0.0" };
  const client = new Client(info);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: withHeaders }));
    return client;
  } catch (first) {
    const fallback = new Client(info);
    try {
      await fallback.connect(new SSEClientTransport(new URL(url), { fetch: withHeaders }));
      return fallback;
    } catch {
      throw first;
    }
  }
}

async function clientFor(s: McpServerRow): Promise<Client> {
  const headers = headersOf(s);
  const fingerprint = createHash("sha256").update(`${s.url}\n${JSON.stringify(headers)}`).digest("hex");
  const known = open.get(s.id);
  if (known && known.fingerprint === fingerprint) {
    known.lastUsed = Date.now();
    return known.client;
  }
  if (known) void known.client.close().catch(() => {});
  const client = await connect(s.url, headers);
  open.set(s.id, { client, fingerprint, lastUsed: Date.now() });
  return client;
}

/** Drops a server's open connection (after it's changed or deleted). */
export function forget(id: number) {
  const known = open.get(id);
  open.delete(id);
  if (known) void known.client.close().catch(() => {});
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

/** Lists a server's tools, every page of them. */
export async function listTools(url: string, headers: Record<string, string>): Promise<McpTool[]> {
  const client = await connect(url, headers);
  try {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      for (const t of page.tools) {
        tools.push({ name: t.name, title: t.title, description: t.description, inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  } finally {
    void client.close().catch(() => {});
  }
}

/** Lists a saved server's tools again and keeps what it said (or why it couldn't). */
export async function refreshServer(s: McpServerRow): Promise<McpServerRow> {
  try {
    const tools = await listTools(s.url, headersOf(s));
    db.prepare("UPDATE mcp_servers SET tools = ?, checked_at = ?, error = NULL WHERE id = ?").run(JSON.stringify(tools), nowIso(), s.id);
  } catch (err) {
    db.prepare("UPDATE mcp_servers SET checked_at = ?, error = ? WHERE id = ?").run(nowIso(), mcpErrorMessage(err), s.id);
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

/** Calls a server's tool. Never throws: a failure comes back as an error for the model. */
export async function callTool(s: McpServerRow, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const reused = open.has(s.id);
    try {
      const client = await clientFor(s);
      const result = (await client.callTool({ name: tool, arguments: input }, undefined, { signal, timeout: CALL_TIMEOUT_MS })) as {
        content?: unknown;
        structuredContent?: unknown;
        toolResult?: unknown;
        isError?: boolean;
      };
      // Servers from before structured results answer with toolResult.
      if (result.content === undefined && result.toolResult !== undefined) return { content: JSON.stringify(result.toolResult, null, 2) };
      return { content: resultText(result), isError: !!result.isError };
    } catch (err) {
      forget(s.id);
      if (signal.aborted) return { content: "Stopped", isError: true };
      // A connection kept from earlier that the server has since dropped (it restarted, say) is
      // opened again once. The call never reached the tool, so nothing runs twice.
      if (attempt === 0 && reused && /session|not connected|closed|404/i.test(String((err as Error)?.message))) continue;
      console.error(`[mcp] ${s.name} ${tool} failed:`, err);
      return { content: mcpErrorMessage(err), isError: true };
    }
  }
  return { content: "The tool couldn't be reached", isError: true };
}
