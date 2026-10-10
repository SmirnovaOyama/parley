// Forgotten passwords. Someone who can't sign in asks for a link by email. It carries a random
// token (only its hash is kept) that works once, for half an hour, and a newer link replaces it.
// Asking gets the same answer whether or not an account uses the address, so the form can't be
// used to find out who has one; how often it's asked is limited by address and by network.
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { hashToken, newToken } from "./crypto.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";
import { mailMode, sendMail } from "./mail.ts";

export const LINK_MINUTES = 30;
/** How long to wait before asking for another link for the same address. */
export const RESEND_AFTER_S = 60;
const LINKS_PER_DAY = 5;
const ASKS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_TRACKED = 50_000;

export const DEAD_LINK = "This link has expired or was already used. Ask for a new one";

/**
 * Where links in emails point, or null when this site can't send them. That's PUBLIC_URL, never
 * the address a request names (anyone could name their own, and get a working link sent to an
 * account's owner that leads there). In development, where mail only goes to the server log, the
 * request's address will do.
 */
export function linkOrigin(c: Context): string | null {
  if (mailMode === "off") return null;
  if (env.publicUrl) return env.publicUrl;
  if (mailMode !== "dev") return null;
  return c.req.header("origin") ?? new URL(c.req.url).origin;
}

if (mailMode === "smtp" && !env.publicUrl) {
  console.warn("PUBLIC_URL isn't set, so people can't reset a forgotten password by email. Set it to the address people reach the site at");
}

/**
 * When each key (an address, a network) last asked, within a window. Keys whose times have all
 * passed are cleared when the list gets long, and it never holds more than MAX_TRACKED (the ones
 * quiet longest go first).
 */
function recent(windowMs: number) {
  const times = new Map<string, number[]>();
  const of = (key: string, now: number) => (times.get(key) ?? []).filter((t) => t > now - windowMs);
  const note = (key: string, now: number) => {
    const kept = [...of(key, now), now];
    times.delete(key);
    times.set(key, kept);
    if (times.size <= MAX_TRACKED) return;
    for (const [k, t] of times) if (t.at(-1)! <= now - windowMs) times.delete(k);
    for (const k of times.keys()) {
      if (times.size <= MAX_TRACKED) break;
      times.delete(k);
    }
  };
  return { of, note };
}

const byAddress = recent(DAY_MS);
const byNetwork = recent(HOUR_MS);

// Addresses a reverse proxy in front of the server connects from: this machine, or a private
// network (Docker's, say).
const NEARBY = new BlockList();
for (const [net, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) {
  NEARBY.addSubnet(net, prefix, "ipv4");
}
NEARBY.addAddress("::1", "ipv6");
NEARBY.addSubnet("fc00::", 7, "ipv6");

function nearby(ip: string): boolean {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? (isIPv4(ip) ? ip : null);
  if (v4) return NEARBY.check(v4, "ipv4");
  return isIPv6(ip) && NEARBY.check(ip, "ipv6");
}

/**
 * Where a request comes from: the address that connected or, when that's a proxy on this machine
 * or network, the one the proxy last added to X-Forwarded-For. Someone reaching the server
 * straight from the internet can't pick it.
 */
export function clientAddress(c: Context): string {
  let remote = "";
  try {
    remote = getConnInfo(c).remote.address ?? "";
  } catch {
    // No Node request under it (a test calling the app directly): where it's from is unknown.
  }
  if (nearby(remote)) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return remote;
}

/**
 * Notes that `email` was asked for from `network`, or says why it's too soon. Every address
 * counts, with an account or not, so the answer gives nothing away.
 */
export function tooSoon(email: string, network: string): string | null {
  const now = Date.now();
  if (byNetwork.of(network, now).length >= ASKS_PER_HOUR) return "Too many links asked for from here. Try again in an hour";
  byNetwork.note(network, now);
  const asked = byAddress.of(email, now);
  if (asked.length && now - asked.at(-1)! < RESEND_AFTER_S * 1000) return "A link for that address was just asked for. Wait a minute before asking again";
  if (asked.length >= LINKS_PER_DAY) return `Links for that address were asked for ${LINKS_PER_DAY} times today. Try again tomorrow`;
  byAddress.note(email, now);
  return null;
}

/**
 * Emails a link to set a new password to the account at `email`, if one uses it and is turned
 * on. It returns straight away and the mail goes in the background, so how long the answer takes
 * doesn't say whether there's an account either.
 */
export function sendResetLink(email: string, origin: string) {
  const now = Date.now();
  db.prepare("DELETE FROM password_resets WHERE expires_at <= ?").run(new Date(now).toISOString());
  const user = db.prepare("SELECT id, email, disabled FROM users WHERE email = ?").get(email) as
    | { id: number; email: string; disabled: number }
    | undefined;
  if (!user || user.disabled) return;

  const token = newToken();
  db.prepare(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
  ).run(user.id, hashToken(token), new Date(now + LINK_MINUTES * 60 * 1000).toISOString(), nowIso());

  // The token goes after the #, which browsers keep to themselves: it isn't sent to the server
  // when the page opens, so it stays out of proxy logs and Referer headers.
  const link = `${origin}/reset-password#${token}`;
  sendMail({
    to: user.email,
    subject: `Reset your ${env.appName} password`,
    text:
      `Someone asked to reset the password of your ${env.appName} account, ${user.email}. To choose a new one, open this link:\n\n${link}\n\n` +
      `It works once, for the next ${LINK_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore this email. Your password stays as it is.`,
  }).catch((err) => console.error("[mail] sending failed:", err));
}

export type Reset = { userId: number; email: string; disabled: boolean };

// The tokens newToken makes: 32 random bytes in base64url.
const TOKEN_RE = /^[\w-]{43}$/;

function resetFor(userId: number, expiresAt: string): Reset | null {
  if (Date.parse(expiresAt) <= Date.now()) return null;
  const user = db.prepare("SELECT email, disabled FROM users WHERE id = ?").get(userId) as { email: string; disabled: number } | undefined;
  return user ? { userId, email: user.email, disabled: !!user.disabled } : null;
}

/** The account a link is for, while it still works. */
export function findReset(token: string): Reset | null {
  if (!TOKEN_RE.test(token)) return null;
  const row = db.prepare("SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?").get(hashToken(token)) as
    | { user_id: number; expires_at: string }
    | undefined;
  return row ? resetFor(row.user_id, row.expires_at) : null;
}

/** Uses a link up: the account it's for, if it still worked. A second try finds nothing. */
export function takeReset(token: string): Reset | null {
  if (!TOKEN_RE.test(token)) return null;
  const row = db.prepare("DELETE FROM password_resets WHERE token_hash = ? RETURNING user_id, expires_at").get(hashToken(token)) as
    | { user_id: number; expires_at: string }
    | undefined;
  return row ? resetFor(row.user_id, row.expires_at) : null;
}
