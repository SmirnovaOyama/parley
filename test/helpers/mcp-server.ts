// A stand-in MCP server: Streamable HTTP on a free local port, with an MCP session for each client
// that connects and four tools (one it calls read-only, one that changes things, one it says
// nothing about, and one that only reads but reaches beyond the server). It remembers every call: the tool, the session it came on and its headers.
//
// With `auth: "token"` it answers only requests bearing a token it was told to accept. With
// `auth: "oauth"` it also runs the sign-in service beside itself, as MCP's authorization spec has
// it: metadata, registering clients, a sign-in page that signs in at once as `signInAs`, tokens
// (PKCE-checked, refresh tokens replaced at each use) and revoking them.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** A call that reached a tool; `account` is whose token it bore (the token itself, for pasted ones). */
export type McpCall = { tool: string; input: unknown; session: string; headers: Record<string, unknown>; account?: string };

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

type Options = { port?: number; auth?: "none" | "token" | "oauth" };
type Client = { client_id: string; client_secret?: string; redirect_uris: string[] };
type Grant = { account: string; client: string; refresh: string };

async function bodyOf(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Listens on `port`, or a free one. */
export async function mcpServer(options: Options | number = {}) {
  const { port = 0, auth = "none" } = typeof options === "number" ? { port: options } : options;
  const calls: McpCall[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let origin = "";

  // Tokens it takes, and whose they are.
  const access = new Map<string, string>();
  const grants = new Map<string, Grant>();
  const clients = new Map<string, Client>();
  const codes = new Map<string, { client: string; redirect: string; challenge: string; account: string; resource: string | null }>();
  const service = {
    /** Who the sign-in page signs in as. */
    signInAs: "someone",
    /** The sign-in page says no, as when the person presses Cancel there. */
    deny: false,
    /** It lets clients register themselves. */
    registration: true,
    /** How long an access token lasts, in seconds. */
    expiresIn: 3600,
    /** Where its metadata says the sign-in page is. */
    authorizeAt: "",
    registrations: [] as Record<string, unknown>[],
    /** Waited for before a refresh is answered, to hold one up partway. */
    beforeRefresh: null as null | (() => Promise<void>),
    refreshes: 0,
    turnedDown: 0,
    revoked: [] as string[],
  };

  function issue(account: string, client: string) {
    const token = `at-${account}-${randomUUID().slice(0, 8)}`;
    const refresh = `rt-${account}-${randomUUID().slice(0, 8)}`;
    access.set(token, account);
    grants.set(refresh, { account, client, refresh });
    return { access_token: token, token_type: "Bearer", expires_in: service.expiresIn, refresh_token: refresh };
  }

  /** The sign-in service: metadata, registering, the sign-in page, tokens, revoking. */
  async function signInService(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      return send(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["notes"] });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return send(res, 200, {
        issuer: origin,
        authorization_endpoint: service.authorizeAt || `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(service.registration ? { registration_endpoint: `${origin}/register` } : {}),
        revocation_endpoint: `${origin}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      });
    }
    if (path === "/register" && req.method === "POST" && service.registration) {
      const asked = JSON.parse(await bodyOf(req));
      service.registrations.push(asked);
      const client = { client_id: `client-${clients.size + 1}`, client_secret: `secret-${randomUUID()}`, redirect_uris: asked.redirect_uris };
      clients.set(client.client_id, client);
      return send(res, 201, { ...asked, ...client, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (path === "/authorize") {
      const q = url.searchParams;
      const client = clients.get(q.get("client_id") ?? "");
      const redirect = q.get("redirect_uri") ?? "";
      if (!client || !client.redirect_uris.includes(redirect) || q.get("code_challenge_method") !== "S256") return send(res, 400, { error: "invalid_request" });
      const back = new URL(redirect);
      back.searchParams.set("state", q.get("state") ?? "");
      if (service.deny) back.searchParams.set("error", "access_denied");
      else {
        const code = randomUUID();
        codes.set(code, { client: client.client_id, redirect, challenge: q.get("code_challenge") ?? "", account: service.signInAs, resource: q.get("resource") });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await bodyOf(req));
      const client = clients.get(form.get("client_id") ?? "");
      if (!client || (client.client_secret && form.get("client_secret") !== client.client_secret)) return send(res, 401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!code || code.client !== client.client_id || code.redirect !== form.get("redirect_uri") || code.challenge !== challenge) {
          return send(res, 400, { error: "invalid_grant" });
        }
        return send(res, 200, issue(code.account, client.client_id));
      }
      if (form.get("grant_type") === "refresh_token") {
        await service.beforeRefresh?.();
        const grant = grants.get(form.get("refresh_token") ?? "");
        if (!grant || grant.client !== client.client_id) return send(res, 400, { error: "invalid_grant" });
        service.refreshes++;
        // Each refresh token works once.
        grants.delete(grant.refresh);
        return send(res, 200, issue(grant.account, client.client_id));
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }
    if (path === "/revoke" && req.method === "POST") {
      const token = new URLSearchParams(await bodyOf(req)).get("token") ?? "";
      service.revoked.push(token);
      grants.delete(token);
      access.delete(token);
      return send(res, 200, {});
    }
    send(res, 404, { error: "not_found" });
  }

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (auth === "oauth" && url.pathname !== "/mcp") return signInService(req, res, url);
    let account: string | undefined;
    if (auth !== "none") {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      account = access.get(bearer);
      if (!account) {
        service.turnedDown++;
        return send(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
      }
    }
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
        const headers = (extra.requestInfo?.headers ?? {}) as Record<string, unknown>;
        const bearer = /^Bearer (.+)$/.exec(String(headers.authorization ?? ""))?.[1];
        calls.push({
          tool: request.params.name,
          input: request.params.arguments,
          session: extra.sessionId ?? "",
          headers,
          ...(bearer && access.has(bearer) ? { account: access.get(bearer) } : {}),
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
  origin = `http://127.0.0.1:${at}`;
  return {
    url: `${origin}/mcp`,
    calls,
    /** The sessions clients opened. */
    sessions: () => sessions.size,
    /** The sign-in service's settings and what it saw (auth: "oauth"). */
    auth: service,
    /** Takes this token from now on, as `account`'s (auth: "token"). */
    accept(token: string, account = token) {
      access.set(token, account);
    },
    /** Stops taking these tokens, as when they run out or are withdrawn. */
    drop(...tokens: string[]) {
      for (const t of tokens) access.delete(t);
    },
    /** Every access token runs out at once. */
    expireAccess() {
      access.clear();
    },
    /** Every sign-in is withdrawn: access and refresh tokens alike. */
    withdrawAll() {
      access.clear();
      grants.clear();
    },
    async close() {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
