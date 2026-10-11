// Where each person is signed in: a session for each sign-in, with the browser it's used in, the
// address it was last used from, and when. People see and end their own under Settings, and admins
// see each person's, so an account passed around, or turned into a relay that hands the site's
// keys to other apps, shows up as many devices, many networks, or a program instead of a browser.
// Signing in on more devices than the site allows signs out the one used longest ago.
import type { Context } from "hono";
import { isIPv4, isIPv6 } from "node:net";
import { db, getSettings, nowIso } from "./db.ts";
import { t } from "./i18n.ts";
import { clientAddress } from "./network.ts";

/** A session's use is written down at most this often, unless its address or browser changes. */
const SEEN_EVERY_MS = 5 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AGENT = 300;

export type SessionRow = { id: string; created_at: string; last_seen_at: string | null; address: string | null; user_agent: string | null };

/** What a session goes by outside the database: the start of its token's hash, which says nothing about the token. */
export const sessionRef = (id: string) => id.slice(0, 16);

/** Where a request comes from and what sent it, as a session keeps them. */
export function seenFrom(c: Context): { address: string | null; userAgent: string | null } {
  // An IPv4 address that came in over IPv6 (::ffff:203.0.113.5) is kept as people know it.
  const address = clientAddress(c).replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
  return { address: address || null, userAgent: c.req.header("user-agent")?.slice(0, MAX_AGENT) || null };
}

/** Notes that session `row` was used by request `c`, unless nothing has changed in the last few minutes. */
export function noteUse(c: Context, row: Pick<SessionRow, "id" | "last_seen_at" | "address" | "user_agent">) {
  const { address, userAgent } = seenFrom(c);
  const fresh = row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < SEEN_EVERY_MS;
  if (fresh && address === row.address && userAgent === row.user_agent) return;
  db.prepare("UPDATE sessions SET last_seen_at = ?, address = ?, user_agent = ? WHERE id = ?").run(nowIso(), address, userAgent, row.id);
}

/** Signs `userId` out of the sessions past the site's limit, the ones used longest ago first. */
export function keepWithinLimit(userId: number, limit = getSettings().maxSessions) {
  if (limit == null) return;
  db.prepare(
    `DELETE FROM sessions WHERE user_id = ?1 AND id NOT IN (
       SELECT id FROM sessions WHERE user_id = ?1 ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT ?2)`,
  ).run(userId, limit);
}

/**
 * Holds everyone to the limit, once it's lowered. The session `asking` came with is noted as used
 * now first: whoever lowered it keeps the device they did it from, though its last use was written
 * down minutes ago.
 */
export function keepEveryoneWithinLimit(asking: string | null) {
  const limit = getSettings().maxSessions;
  if (limit == null) return;
  if (asking) db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), asking);
  const over = db.prepare("SELECT user_id FROM sessions GROUP BY user_id HAVING COUNT(*) > ?").all(limit) as { user_id: number }[];
  for (const { user_id } of over) keepWithinLimit(user_id, limit);
}

/** Forgets sessions that ran out, with where they were used. */
export function clearExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}

// Checked in order: Edge and Opera say Chrome too, Chrome says Safari, and every one says Mozilla.
const BROWSERS: [RegExp, string][] = [
  [/MicroMessenger\//, "WeChat"],
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, "iOS"],
  [/iPad/, "iPadOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

/**
 * What a session is used in, from its User-Agent: a browser and its system ("Chrome on macOS"), or
 * the program when it isn't a browser ("curl", "python-requests"), which is how a script calling
 * the site with someone's sign-in shows itself unless it pretends otherwise.
 */
export function deviceOf(agent: string | null): { device: string; browser: boolean } {
  if (!agent) return { device: t("Unknown device"), browser: false };
  if (!agent.startsWith("Mozilla/")) return { device: agent.match(/^[^/\s;()]+/)?.[0] ?? t("Unknown program"), browser: false };
  const browser = BROWSERS.find(([re]) => re.test(agent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(agent))?.[1];
  const device = browser && system ? t("{browser} on {system}", { browser, system }) : browser ? browser : system ? t("A browser on {system}", { system }) : t("A browser");
  return { device, browser: true };
}

/** The network an address belongs to, roughly: its first three numbers (IPv4) or first four groups (IPv6). */
export function networkOf(address: string | null): string | null {
  if (!address) return null;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? (isIPv4(address) ? address : null);
  if (v4) return v4.split(".").slice(0, 3).join(".");
  if (!isIPv6(address)) return null;
  // Written out in full first, so "2001:db8::1" and "2001:db8:0:0::2" come out the same.
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":");
}

export type SessionOut = {
  id: string;
  device: string;
  /** Whether it's used in a browser; false for a program calling the site. */
  browser: boolean;
  address: string | null;
  signedInAt: string;
  /** When it was last used; null for a sign-in from before this was kept that hasn't been used since. */
  lastSeenAt: string | null;
  /** The session the request asking came with. */
  current: boolean;
};

/** Where `userId` is signed in, the most recently used first. */
export function sessionsOf(userId: number, currentId: string | null = null): SessionOut[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, last_seen_at, address, user_agent FROM sessions
       WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_seen_at, created_at) DESC`,
    )
    .all(userId, nowIso()) as SessionRow[];
  return rows.map((r) => ({
    id: sessionRef(r.id),
    ...deviceOf(r.user_agent),
    address: r.address,
    signedInAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.id === currentId,
  }));
}

/** How many devices a person is signed in on, and how many networks the ones used in the last week came from. */
export function spreadOf(sessions: SessionOut[]): { devices: number; networks: number; programs: number } {
  const since = Date.now() - WEEK_MS;
  const recent = sessions.filter((s) => s.lastSeenAt && Date.parse(s.lastSeenAt) >= since);
  return {
    devices: sessions.length,
    networks: new Set(recent.map((s) => networkOf(s.address)).filter(Boolean)).size,
    programs: sessions.filter((s) => !s.browser).length,
  };
}

/** Signs `userId` out of the session `ref` names; false when they have none by that name. */
export function endSessionByRef(userId: number, ref: string): boolean {
  if (!/^[0-9a-f]{16}$/.test(ref)) return false;
  return db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?").run(userId, ref).changes > 0;
}
