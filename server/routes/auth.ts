import { Hono } from "hono";
import { endSession, requireUser, startSession, type AppEnv } from "../auth.ts";
import { hashPassword, verifyPassword } from "../crypto.ts";
import { allowanceOf } from "../allowance.ts";
import { bonusOf, BonusError, pendingCode, rewardDomain, sendCode, verifyCode } from "../bonus.ts";
import { db, getSettings, nowIso } from "../db.ts";
import { getInstructions } from "../instructions.ts";
import { mailMode } from "../mail.ts";
import { modelLabel } from "../providers/catalog.ts";

export const authRoutes = new Hono<AppEnv>();

// Each part of the domain is matched on its own (no dots inside), so a long string fails fast.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
/** The longest address there can be. */
const MAX_EMAIL = 254;
export const MIN_PASSWORD = 8;

// Failed sign-ins per email, to slow down password guessing. Entries past their time are cleared
// when the list gets long, and it never holds more than MAX_TRACKED (the oldest go first).
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60 * 1000;
const MAX_TRACKED = 50_000;

function noteFailure(email: string, lock: { count: number; until: number } | undefined) {
  const now = Date.now();
  const prev = lock && lock.until > now ? lock.count : 0;
  failures.set(email, { count: prev + 1, until: now + LOCK_MS });
  if (failures.size <= MAX_TRACKED) return;
  for (const [key, f] of failures) if (f.until <= now) failures.delete(key);
  for (const key of failures.keys()) {
    if (failures.size <= MAX_TRACKED) break;
    failures.delete(key);
  }
}

function userCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

authRoutes.get("/state", (c) => {
  return c.json({ needsSetup: userCount() === 0, allowSignup: getSettings().allowSignup });
});

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
  if (password.length < MIN_PASSWORD) return c.json({ error: `Use at least ${MIN_PASSWORD} characters for the password` }, 400);

  // The very first account sets the site up and becomes its admin.
  const first = userCount() === 0;
  if (!first && !getSettings().allowSignup) return c.json({ error: "Sign-ups are closed. Ask an admin for an account" }, 403);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const result = db
    .prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
    .run(email, await hashPassword(password), first ? "admin" : "user", nowIso());
  startSession(c, Number(result.lastInsertRowid));
  // An address on a rewarded domain is offered the (optional) check that earns the reward.
  return c.json({ ok: true, bonusEligible: !first && mailMode !== "off" && !!rewardDomain(email) });
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  // No account has an address this long; it isn't worth remembering as a failure either.
  if (email.length > MAX_EMAIL) return c.json({ error: "That email and password don't match" }, 401);

  const lock = failures.get(email);
  if (lock && lock.count >= MAX_FAILURES && lock.until > Date.now()) {
    return c.json({ error: "Too many attempts. Try again in 15 minutes" }, 429);
  }

  const user = db.prepare("SELECT id, password_hash, disabled FROM users WHERE email = ?").get(email) as
    | { id: number; password_hash: string; disabled: number }
    | undefined;
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) {
    noteFailure(email, lock);
    return c.json({ error: "That email and password don't match" }, 401);
  }
  if (user.disabled) return c.json({ error: "This account is turned off. Ask an admin" }, 403);

  failures.delete(email);
  startSession(c, user.id);
  return c.json({ ok: true });
});

authRoutes.post("/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});

authRoutes.get("/me", requireUser, (c) => c.json({ user: c.var.user }));

authRoutes.post("/password", requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = String(body.current ?? "");
  const next = String(body.next ?? "");
  if (next.length < MIN_PASSWORD) return c.json({ error: `Use at least ${MIN_PASSWORD} characters for the new password` }, 400);

  const userId = c.var.user!.id;
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string };
  if (!(await verifyPassword(current, row.password_hash))) {
    return c.json({ error: "The current password isn't right" }, 400);
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(next), userId);
  // Sign out every other device, then keep this one signed in with a fresh session.
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  startSession(c, userId);
  return c.json({ ok: true });
});

// What new chats start with: the persona picked for them (set under Account › Personas).
authRoutes.get("/instructions", requireUser, (c) => c.json(getInstructions(c.var.user!.id)));

// What this person has used this month, against their limits (the email reward included).
authRoutes.get("/allowance", requireUser, (c) => c.json(allowanceOf(c.var.user!.id)));

// ── Email rewards: prove an address on a rewarded domain, get the bonus ──

authRoutes.get("/bonus", requireUser, (c) => {
  const userId = c.var.user!.id;
  const { bonusDomains } = getSettings();
  const bonus = bonusOf(userId);
  const keys = bonus.keyIds.length
    ? (db
        .prepare("SELECT provider, model FROM api_keys WHERE id IN (SELECT value FROM json_each(?)) ORDER BY created_at")
        .all(JSON.stringify(bonus.keyIds)) as { provider: string; model: string }[])
    : [];
  const pending = pendingCode(userId);
  return c.json({
    domains: bonusDomains,
    verified: bonus.email ? { email: bonus.email, at: bonus.verifiedAt, active: bonus.eligible } : null,
    reward: { tokens: bonus.tokens, spend: bonus.spend, models: [...new Set(keys.map((k) => modelLabel(k.provider, k.model)))] },
    pending: pending ? { email: pending.email, resendIn: Math.ceil(pending.resendInMs / 1000) } : null,
    mail: mailMode,
  });
});

const bonusFailure = (err: unknown) => {
  if (err instanceof BonusError) return { message: err.message, status: err.status };
  throw err;
};

authRoutes.post("/bonus/send", requireUser, async (c) => {
  if (mailMode === "off") return c.json({ error: "Email isn't set up on this site" }, 503);
  const body = await c.req.json().catch(() => ({}));
  try {
    const sent = await sendCode(c.var.user!.id, String(body.email ?? ""));
    return c.json({ sentTo: sent.email, resendIn: Math.ceil(sent.resendInMs / 1000) });
  } catch (err) {
    const { message, status } = bonusFailure(err);
    return c.json({ error: message }, status);
  }
});

authRoutes.post("/bonus/verify", requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const email = verifyCode(c.var.user!.id, String(body.code ?? ""));
    return c.json({ email });
  } catch (err) {
    const { message, status } = bonusFailure(err);
    return c.json({ error: message }, status);
  }
});
