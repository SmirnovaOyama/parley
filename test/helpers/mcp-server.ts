// A stand-in MCP server: Streamable HTTP on a free local port, with an MCP session for each client
// that connects and four tools (one it calls read-only, one that changes things, one it says
// nothing about, and one that only reads but reaches beyond the server). It remembers every call: the tool, the session it came on and its headers.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type McpCall = { tool: string; input: unknown; session: string; headers: Record<string, unknown> };

const TOOLS = [
  { name: "read_notes", description: "Reads the notes", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  {
    name: "add_note",
    description: "Adds a note",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Add a note" },
  },
  { name: "ping", description: "Says pong", inputSchema: { type: "object", properties: {} } },
  {
    name: "fetch",
    description: "Fetches any address",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

/** Listens on `port`, or a free one. */
export async function mcpServer(port = 0) {
  const calls: McpCall[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    const id = req.headers["mcp-session-id"];
    let transport = typeof id === "string" ? sessions.get(id) : undefined;
    if (!transport) {
      const fresh: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sid) => void sessions.set(sid, fresh),
      });
      const server = new Server({ name: "notes", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        calls.push({
          tool: request.params.name,
          input: request.params.arguments,
          session: extra.sessionId ?? "",
          headers: (extra.requestInfo?.headers ?? {}) as Record<string, unknown>,
        });
        return { content: [{ type: "text", text: `${request.params.name} done` }] };
      });
      await server.connect(fresh);
      transport = fresh;
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  const { port: at } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${at}/mcp`,
    calls,
    /** The sessions clients opened. */
    sessions: () => sessions.size,
    async close() {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
