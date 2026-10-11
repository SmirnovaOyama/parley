import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db, nowIso } from "./db.ts";
import { hashToken, newToken } from "./crypto.ts";
import { env } from "./env.ts";
import { keepWithinLimit, noteUse, seenFrom } from "./sessions.ts";

export type SessionUser = { id: number; email: string; role: "admin" | "user" };
/** user: who's signed in, if anyone. sessionId: the session their request came with (its id in the database). */
export type AppEnv = { Variables: { user: SessionUser | null; sessionId: string | null } };

const COOKIE = "sid";
const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function startSession(c: Context<AppEnv>, userId: number) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * DAY_MS);
  const now = nowIso();
  const { address, userAgent } = seenFrom(c);
  db.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(hashToken(token), userId, expires.toISOString(), now, now, address, userAgent);
  // One device more than the site allows signs out the one used longest ago.
  keepWithinLimit(userId);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.isProd,
    path: "/",
    expires,
  });
}

export function endSession(c: Context<AppEnv>) {
  const token = getCookie(c, COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
  deleteCookie(c, COOKIE, { path: "/" });
}

/**
 * Loads the signed-in user (or null) into c.var.user, slides the session expiry forward, and notes
 * where and in what the session was used (server/sessions.ts).
 */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  c.set("sessionId", null);
  const token = getCookie(c, COOKIE);
  if (token) {
    const id = hashToken(token);
    const row = db
      .prepare(
        `SELECT s.expires_at, s.last_seen_at, s.address, s.user_agent, u.id, u.email, u.role, u.disabled
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      )
      .get(id) as
      | { expires_at: string; last_seen_at: string | null; address: string | null; user_agent: string | null; id: number; email: string; role: "admin" | "user"; disabled: number }
      | undefined;
    const expiresAt = row ? Date.parse(row.expires_at) : 0;
    if (row && !row.disabled && expiresAt > Date.now()) {
      c.set("user", { id: row.id, email: row.email, role: row.role });
      c.set("sessionId", id);
      noteUse(c, { id, last_seen_at: row.last_seen_at, address: row.address, user_agent: row.user_agent });
      if (expiresAt - Date.now() < (SESSION_DAYS / 2) * DAY_MS) {
        const expires = new Date(Date.now() + SESSION_DAYS * DAY_MS);
        db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(expires.toISOString(), id);
        setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: env.isProd, path: "/", expires });
      }
    } else if (row) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      deleteCookie(c, COOKIE, { path: "/" });
    }
  }
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user) return c.json({ error: "Sign in to continue" }, 401);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user) return c.json({ error: "Sign in to continue" }, 401);
  if (c.var.user.role !== "admin") return c.json({ error: "Admins only" }, 403);
  await next();
};

/**
 * The address the person reached the site at: what their browser said it sent from (the guard
 * below has checked it), else what the request was for, as a proxy in front passed it on.
 */
export function originOf(c: Context): string {
  const origin = c.req.header("origin");
  if (origin && origin !== "null") return origin;
  const url = new URL(c.req.url);
  const host = c.req.header("x-forwarded-host")?.split(",")[0].trim() || c.req.header("host") || url.host;
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

/**
 * Cross-site request guard. Session cookies are SameSite=Lax, and every state-changing request
 * must be JSON (which a cross-site form can't send without a CORS preflight we never allow).
 * A mismatched Origin is rejected outright.
 *
 * A change must also come from one of the site's own pages in a browser. Every browser names the
 * page a POST, PUT, PATCH or DELETE comes from in Origin, and today's say how it relates to the
 * site in Sec-Fetch-Site. A request with no Origin was made by a script: one that sends messages
 * with someone's session cookie is how an account becomes a relay (a reverse proxy) that hands
 * the site's keys to other apps or other people. The headers can be faked, so this only stops the
 * plainest scripts; the limits on sending in server/routes/chat.ts hold back the rest.
 */
export const sameOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  // A sandboxed page (code from a reply, running in the preview) has no origin of its own and
  // never needs the API, whatever the method.
  if (origin === "null") return c.json({ error: "Cross-site request blocked" }, 403);
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin") return c.json({ error: "Cross-site request blocked" }, 403);
  if (!origin) return c.json({ error: "Open the site in a browser to do this" }, 403);
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!URL.canParse(origin) || (host && new URL(origin).host !== host)) {
    return c.json({ error: "Cross-site request blocked" }, 403);
  }
  if (c.req.method === "POST" && !c.req.header("content-type")?.startsWith("application/json")) {
    return c.json({ error: "Expected a JSON body" }, 415);
  }
  await next();
};
