// People's own accounts on MCP servers that work that way (auth_mode 'oauth' or 'token'): each
// person's credential, kept encrypted like API keys; signing in on a server's own sign-in page
// (MCP's OAuth flow, with PKCE); and keeping those sign-ins fresh. A person's requests only ever
// carry their own credential, never anyone else's and never the admin's headers, so a person who
// hasn't connected can't use the server's tools. The connections themselves live in mcp.ts.
import { randomBytes } from "node:crypto";
import { auth, refreshAuthorization, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";
import { fetchOutside } from "./web-tools.ts";

/** Whose account a server's tools act with: one shared (the admin's headers), each person signing in, or each pasting a token. */
export type AuthMode = "shared" | "oauth" | "token";
export const AUTH_MODES: readonly AuthMode[] = ["shared", "oauth", "token"];

/** What this file reads of a server. */
export type ServerAuth = { id: number; url: string; auth_mode: string; oauth_client: string | null; oauth_registration: string | null };

/** A server whose tools act with each person's own account. */
export const personal = (s: Pick<ServerAuth, "auth_mode">) => s.auth_mode === "oauth" || s.auth_mode === "token";

type TokenSecret = { kind: "token"; headers: Record<string, string> };
type OAuthSecret = {
  kind: "oauth";
  tokens: OAuthTokens;
  /** The client the tokens were issued to: refreshing them needs the same one. */
  client: OAuthClientInformationMixed;
  /** The sign-in service that issued them, what it said of itself, and the server they're for. */
  authServer: string;
  metadata?: AuthorizationServerMetadata;
  resource?: string;
  /** When the access token runs out (ms since 1970), where the service said. */
  expiresAt?: number;
};
type Secret = TokenSecret | OAuthSecret;

export type CredentialRow = {
  server_id: number;
  user_id: number;
  secret: string | null;
  status: "ok" | "expired";
  connected_at: string;
  used_at: string | null;
};

/** Why a call can't go ahead on the person's own account: they never connected it, or it stopped working. */
export type AccountState = "missing" | "expired";

/** A request that couldn't carry the person's own account. */
export class AccountError extends Error {
  reason: AccountState;
  constructor(reason: AccountState) {
    super(reason === "missing" ? "This person hasn't connected their account" : "This person's account needs connecting again");
    this.reason = reason;
  }
}

/** The AccountError behind a failure, wherever the SDK wrapped it. */
export function accountErrorIn(err: unknown): AccountError | null {
  for (let e = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) if (e instanceof AccountError) return e;
  return null;
}

// ── Credentials ─────────────────────────────────────────────────────

export function credentialOf(serverId: number, userId: number): CredentialRow | undefined {
  return db.prepare("SELECT * FROM mcp_credentials WHERE server_id = ? AND user_id = ?").get(serverId, userId) as CredentialRow | undefined;
}

/** Where a person stands with a server that wants their own account (null: connected, or it doesn't). */
export function accountState(s: Pick<ServerAuth, "id" | "auth_mode">, userId: number): AccountState | null {
  if (!personal(s)) return null;
  const row = credentialOf(s.id, userId);
  return !row ? "missing" : row.status === "ok" ? null : "expired";
}

function readSecret(row: Pick<CredentialRow, "secret">): Secret | null {
  if (!row.secret) return null;
  try {
    return JSON.parse(decryptSecret(row.secret)) as Secret;
  } catch {
    return null;
  }
}

/** Keeps a person's new credential for a server, in place of any before it. */
export function saveCredential(serverId: number, userId: number, secret: Secret) {
  db.prepare(
    `INSERT INTO mcp_credentials (server_id, user_id, secret, status, connected_at) VALUES (?, ?, ?, 'ok', ?)
     ON CONFLICT (server_id, user_id) DO UPDATE SET secret = excluded.secret, status = 'ok', connected_at = excluded.connected_at, used_at = NULL`,
  ).run(serverId, userId, encryptSecret(JSON.stringify(secret)), nowIso());
}

/**
 * Its credential stopped working: forgotten, and the person is asked to connect again. Only the
 * one connected at `connectedAt`: one they connected since is another, and may well work.
 */
function markExpired(serverId: number, userId: number, connectedAt: string) {
  db.prepare("UPDATE mcp_credentials SET secret = NULL, status = 'expired' WHERE server_id = ? AND user_id = ? AND connected_at = ?").run(
    serverId,
    userId,
    connectedAt,
  );
}

/** Notes that a person's credential carried a call. */
export function markUsed(serverId: number, userId: number) {
  db.prepare("UPDATE mcp_credentials SET used_at = ? WHERE server_id = ? AND user_id = ?").run(nowIso(), serverId, userId);
}

/**
 * Credentials nobody may use any more: a person turned off, a server shared again, or a server no
 * longer open to the person. Admins keep theirs, which is what lists a server's tools.
 */
const UNUSABLE = `user_id IN (SELECT id FROM users WHERE disabled = 1)
  OR server_id IN (SELECT id FROM mcp_servers WHERE auth_mode NOT IN ('oauth', 'token'))
  OR NOT (user_id IN (SELECT id FROM users WHERE role = 'admin')
    OR server_id IN (SELECT id FROM mcp_servers WHERE shared = 1)
    OR EXISTS (SELECT 1 FROM group_mcp gm JOIN group_members m ON m.group_id = gm.group_id
               WHERE gm.server_id = mcp_credentials.server_id AND m.user_id = mcp_credentials.user_id))`;

/**
 * Deletes the credentials that match (or that nobody may use any more, for "unusable"), and asks
 * each sign-in service to revoke what it issued, as far as it offers to. Returns whose they were.
 */
export function dropCredentials(which: "unusable" | { server: number; user?: number }): { serverId: number; userId: number }[] {
  const [where, params] =
    which === "unusable"
      ? [UNUSABLE, []]
      : which.user === undefined
        ? ["server_id = ?", [which.server]]
        : ["server_id = ? AND user_id = ?", [which.server, which.user]];
  const rows = db.prepare(`SELECT * FROM mcp_credentials WHERE ${where}`).all(...params) as CredentialRow[];
  if (!rows.length) return [];
  db.prepare(`DELETE FROM mcp_credentials WHERE ${where}`).run(...params);
  const urlOf = db.prepare("SELECT url FROM mcp_servers WHERE id = ?");
  for (const row of rows) {
    const secret = readSecret(row);
    const server = urlOf.get(row.server_id) as { url: string } | undefined;
    if (secret?.kind === "oauth" && server) void revoke(server.url, secret);
  }
  return rows.map((r) => ({ serverId: r.server_id, userId: r.user_id }));
}

/** Asks the sign-in service to withdraw a person's tokens (RFC 7009), where it offers to. Best effort. */
async function revoke(serverUrl: string, secret: OAuthSecret) {
  // (OpenID's metadata doesn't name it, OAuth's does.)
  const endpoint = (secret.metadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  // Revoking the refresh token ends the access tokens made from it too.
  const [token, hint] = secret.tokens.refresh_token ? [secret.tokens.refresh_token, "refresh_token"] : [secret.tokens.access_token, "access_token"];
  if (!endpoint || !token) return;
  const body = new URLSearchParams({ token, token_type_hint: hint, client_id: secret.client.client_id });
  if (secret.client.client_secret) body.set("client_secret", secret.client.client_secret);
  try {
    const res = await oauthFetch(serverUrl)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
  } catch {
    // The person's side is gone either way; the service lets its tokens run out.
  }
}

// ── What a person's requests carry ──────────────────────────────────

/** Header names a person can't set: Parley names who's asking itself. */
const RESERVED = /^x-parley-user$/i;

/** A person's pasted headers, without any they may not set. */
export const ownHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).filter(([name]) => !RESERVED.test(name)));

/**
 * What a person's request to a server carries: their pasted token's headers, or their OAuth access
 * token (refreshed first when it's about to run out), with that token named for a retry, and when
 * the credential was connected.
 */
export async function personalCredential(
  s: ServerAuth,
  userId: number,
): Promise<{ headers: Record<string, string>; accessToken?: string; connectedAt: string }> {
  const row = credentialOf(s.id, userId);
  const secret = row?.status === "ok" ? readSecret(row) : null;
  if (!row || !secret || secret.kind !== (s.auth_mode === "oauth" ? "oauth" : "token")) throw new AccountError(row ? "expired" : "missing");
  if (secret.kind === "token") return { headers: ownHeaders(secret.headers), connectedAt: row.connected_at };
  let accessToken = secret.tokens.access_token;
  if (secret.expiresAt && secret.expiresAt - 60_000 < Date.now() && secret.tokens.refresh_token) accessToken = await refreshed(s, userId, accessToken);
  return { headers: { Authorization: `Bearer ${accessToken}` }, accessToken, connectedAt: row.connected_at };
}

/**
 * The server turned down the person's credential connected at `connectedAt`: a pasted token, or a
 * sign-in that can't be refreshed, needs connecting again.
 */
export function rejected(s: ServerAuth, userId: number, connectedAt: string): AccountError {
  markExpired(s.id, userId, connectedAt);
  return new AccountError("expired");
}

/** Refreshes in flight, by server and person, so a refresh token is never spent twice at once. */
const refreshing = new Map<string, Promise<string>>();

/**
 * A fresh access token in place of `stale`, which ran out or was turned down. However many
 * requests ask at the same moment, the service is asked once. A refresh the service refuses means
 * the person signs in again; one that can't reach it leaves the sign-in as it was.
 */
export function refreshed(s: ServerAuth, userId: number, stale: string): Promise<string> {
  const key = `${s.id}:${userId}`;
  const running = refreshing.get(key);
  if (running) return running;
  const run = (async () => {
    const row = credentialOf(s.id, userId);
    const secret = row?.status === "ok" ? readSecret(row) : null;
    if (!row || !secret || secret.kind !== "oauth") throw new AccountError(row ? "expired" : "missing");
    // Another request refreshed it meanwhile.
    if (secret.tokens.access_token !== stale) return secret.tokens.access_token;
    if (!secret.tokens.refresh_token) throw rejected(s, userId, row.connected_at);
    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(secret.authServer, {
        metadata: secret.metadata,
        clientInformation: secret.client,
        refreshToken: secret.tokens.refresh_token,
        resource: secret.resource ? new URL(secret.resource) : undefined,
        fetchFn: oauthFetch(s.url),
      });
    } catch (err) {
      if (err instanceof OAuthError && !(err instanceof ServerError)) throw rejected(s, userId, row.connected_at);
      throw err;
    }
    // Only the tokens change: the sign-in is the same one, from the same time. One the person
    // dropped or replaced while this ran stays as they left it, and its tokens aren't used.
    const kept = db
      .prepare("UPDATE mcp_credentials SET secret = ? WHERE server_id = ? AND user_id = ? AND connected_at = ? AND status = 'ok'")
      .run(encryptSecret(JSON.stringify({ ...secret, tokens, expiresAt: expiryOf(tokens) } satisfies OAuthSecret)), s.id, userId, row.connected_at);
    if (!kept.changes) throw new AccountError(credentialOf(s.id, userId) ? "expired" : "missing");
    return tokens.access_token;
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, run);
  return run;
}

const expiryOf = (tokens: OAuthTokens) => (tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined);

/**
 * fetch for a server's sign-in service. The server's own host is where an admin pointed Parley,
 * so it's reached as it is (it may well be inside the network). Any other address the server
 * names for signing in must be on the public web, so a server can't steer Parley's requests inward.
 */
export function oauthFetch(serverUrl: string): typeof fetch {
  const home = new URL(serverUrl).hostname;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === home ? fetch(url, init) : fetchOutside(url, init);
  };
}

// ── Signing in on the server's own page ─────────────────────────────

/** Where a server's sign-in page sends people back: PUBLIC_URL, or the address they use Parley at. */
export const callbackUrl = (origin: string) => `${env.publicUrl ?? origin}/api/mcp/callback`;

/** Where a sign-in was started from, which is where it comes back to. */
export type SignInFrom = "account" | "admin";

/** A sign-in under way: what's needed when the person comes back with a code, for ten minutes. */
type Pending = {
  serverId: number;
  /** The server's address then: a sign-in for one it has moved from isn't kept. */
  serverUrl: string;
  userId: number;
  from: SignInFrom;
  redirectUrl: string;
  verifier: string;
  client: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  expires: number;
};
const pending = new Map<string, Pending>();
const PENDING_MS = 10 * 60_000;
/** Sign-ins one person can have under way at once; starting another drops their oldest. */
const MAX_PENDING_EACH = 5;

/** A client an admin registered with the server's sign-in service, for services Parley can't register with itself. */
export function adminClient(s: Pick<ServerAuth, "oauth_client">): { client_id: string; client_secret?: string } | null {
  if (!s.oauth_client) return null;
  try {
    return JSON.parse(decryptSecret(s.oauth_client));
  } catch {
    return null;
  }
}

/** The client Parley registered itself, while it was registered for this callback address. */
function registeredClient(s: Pick<ServerAuth, "oauth_registration">, redirectUrl: string): OAuthClientInformationMixed | undefined {
  if (!s.oauth_registration) return undefined;
  try {
    const kept = JSON.parse(decryptSecret(s.oauth_registration)) as { client: OAuthClientInformationMixed; redirectUrl: string };
    return kept.redirectUrl === redirectUrl ? kept.client : undefined;
  } catch {
    return undefined;
  }
}

/** What the SDK's auth() needs of a client for one sign-in (starting it, or taking the code back), and what it hands back. */
function signInProvider(s: ServerAuth, redirectUrl: string, held?: Pending) {
  const out: {
    state?: string;
    verifier?: string;
    url?: URL;
    client?: OAuthClientInformationMixed;
    discovery?: OAuthDiscoveryState;
    tokens?: OAuthTokens;
  } = { client: held?.client, verifier: held?.verifier, discovery: held?.discovery };
  const own = adminClient(s);
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: env.appName,
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      };
    },
    state: () => (out.state = randomBytes(24).toString("base64url")),
    // Whichever client it signs in with is the one the person's tokens are refreshed with later.
    clientInformation: () => (out.client ??= own ?? registeredClient(s, redirectUrl)),
    saveClientInformation: (client) => {
      out.client = client;
      // Registered just now: kept for everyone's later sign-ins through this address.
      if (!own) {
        db.prepare("UPDATE mcp_servers SET oauth_registration = ? WHERE id = ?").run(encryptSecret(JSON.stringify({ client, redirectUrl })), s.id);
      }
    },
    tokens: () => undefined,
    saveTokens: (tokens) => void (out.tokens = tokens),
    redirectToAuthorization: (url) => void (out.url = url),
    saveCodeVerifier: (verifier) => void (out.verifier = verifier),
    codeVerifier: () => out.verifier ?? "",
    discoveryState: () => out.discovery,
    saveDiscoveryState: (state) => void (out.discovery = state),
  };
  return { provider, out };
}

/** A sentence for a sign-in that couldn't start or finish. */
export function signInErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/dynamic client registration/i.test(message)) {
    return "Its sign-in service doesn't let Parley register itself. An admin can register Parley there and add the client ID on the server's page";
  }
  if (err instanceof OAuthError) return `Its sign-in service turned the request down: ${message.slice(0, 200)}`;
  if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|fetch failed|timed? ?out|inside this server's network|stand-in address/i.test(message)) {
    return "Couldn't reach its sign-in service";
  }
  return `Its sign-in service answered with an error: ${message.slice(0, 200)}`;
}

/**
 * Starts a person's sign-in to a server: finds its sign-in service, registers Parley with it if
 * need be, and returns the address of its sign-in page, for the person's browser to go to.
 */
export async function startSignIn(s: ServerAuth, userId: number, redirectUrl: string, from: SignInFrom): Promise<string> {
  const { provider, out } = signInProvider(s, redirectUrl);
  const result = await auth(provider, { serverUrl: s.url, fetchFn: oauthFetch(s.url) });
  if (result !== "REDIRECT" || !out.url || !out.state || !out.verifier || !out.client) throw new Error("It offered no sign-in page");
  // The browser goes there next, so it's a web page and nothing else.
  if (out.url.protocol !== "https:" && out.url.protocol !== "http:") throw new Error("Its sign-in page isn't a web address");
  const now = Date.now();
  for (const [key, p] of pending) if (p.expires < now) pending.delete(key);
  const theirs = [...pending].filter(([, p]) => p.userId === userId);
  for (const [key] of theirs.slice(0, Math.max(0, theirs.length - MAX_PENDING_EACH + 1))) pending.delete(key);
  pending.set(out.state, {
    serverId: s.id,
    serverUrl: s.url,
    userId,
    from,
    redirectUrl,
    verifier: out.verifier,
    client: out.client,
    discovery: out.discovery,
    expires: now + PENDING_MS,
  });
  return out.url.href;
}

/** The sign-in a person came back from, taken off the list (null: none of theirs, or it ran out). */
export function takeSignIn(state: string, userId: number | undefined): Pending | null {
  const held = pending.get(state);
  if (!held) return null;
  pending.delete(state);
  return held.userId === userId && held.expires >= Date.now() ? held : null;
}

/** Trades the code a person came back with for their tokens, and keeps them. */
export async function finishSignIn(s: ServerAuth, held: Pending, code: string): Promise<void> {
  const { provider, out } = signInProvider(s, held.redirectUrl, held);
  const result = await auth(provider, { serverUrl: s.url, authorizationCode: code, fetchFn: oauthFetch(s.url) });
  if (result !== "AUTHORIZED" || !out.tokens || !out.client || !out.discovery) throw new Error("It sent back no sign-in");
  saveCredential(held.serverId, held.userId, {
    kind: "oauth",
    tokens: out.tokens,
    client: out.client,
    authServer: out.discovery.authorizationServerUrl,
    metadata: out.discovery.authorizationServerMetadata,
    resource: out.discovery.resourceMetadata?.resource,
    expiresAt: expiryOf(out.tokens),
  });
}
