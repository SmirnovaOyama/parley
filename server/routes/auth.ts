import { Hono } from "hono";
import { endSession, requireUser, startSession, type AppEnv } from "../auth.ts";
import { hashPassword, verifyPassword } from "../crypto.ts";
import { allowanceOf } from "../allowance.ts";
import { bonusOf, BonusError, pendingCode, rewardDomain, sendCode, verifyCode } from "../bonus.ts";
import { db, getSettings, nowIso } from "../db.ts";
import { getInstructions } from "../instructions.ts";
import { mailMode } from "../mail.ts";
import { clientAddress } from "../network.ts";
import { DEAD_LINK, findReset, linkOrigin, RESEND_AFTER_S, sendResetLink, takeReset, tooSoon } from "../password-reset.ts";
import { modelLabel } from "../providers/catalog.ts";
import { endSessionByRef, sessionRef, sessionsOf } from "../sessions.ts";
import { RESEND_AFTER_S as CODE_RESEND_S, sendSignupCode, SignupCodeError, signupNeedsCode, takeSignupCode } from "../signup-codes.ts";
import { finishWithCode, finishWithPasskey, signInPasskeyOptions, startSecondStep, ticketOf, twoStepOf, twoStepOn } from "../two-step.ts";

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

/** Forgets the failed sign-ins for `email`, once its account has a new password. */
export function clearFailures(email: string) {
  failures.delete(email);
}

const TOO_MANY = "Too many attempts. Try again in 15 minutes";
const locked = (lock: { count: number; until: number } | undefined) => !!lock && lock.count >= MAX_FAILURES && lock.until > Date.now();

/**
 * Checks the password of someone signed in, before a change that takes it (adding or removing a
 * way of two-step verification). Misses count with failed sign-ins. Returns what's wrong, if anything.
 */
export async function confirmPassword(userId: number, password: unknown): Promise<string | null> {
  const row = db.prepare("SELECT email, password_hash FROM users WHERE id = ?").get(userId) as { email: string; password_hash: string };
  const lock = failures.get(row.email);
  if (locked(lock)) return TOO_MANY;
  if (await verifyPassword(String(password ?? ""), row.password_hash)) return null;
  noteFailure(row.email, lock);
  return "That password isn't right";
}

function userCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

authRoutes.get("/state", (c) => {
  const needsSetup = userCount() === 0;
  return c.json({
    needsSetup,
    allowSignup: getSettings().allowSignup,
    passwordReset: !!linkOrigin(c),
    // Making an account takes a code emailed to it (server/signup-codes.ts); the first never does.
    signupCode: !needsSetup && signupNeedsCode(),
  });
});

/** Emails a code to the address an account is being made for, when making one takes a code. */
authRoutes.post("/signup/code", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
  if (userCount() === 0 || !signupNeedsCode()) return c.json({ error: "Making an account here takes no code" }, 400);
  if (!getSettings().allowSignup) return c.json({ error: "Sign-ups are closed. Ask an admin for an account" }, 403);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }
  try {
    await sendSignupCode(email, clientAddress(c));
  } catch (err) {
    if (err instanceof SignupCodeError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  return c.json({ ok: true, resendIn: CODE_RESEND_S, mail: mailMode });
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
  const checked = !first && signupNeedsCode();
  if (checked) {
    try {
      takeSignupCode(email, body.code);
    } catch (err) {
      if (err instanceof SignupCodeError) return c.json({ error: err.message, field: "code" }, err.status);
      throw err;
    }
  }

  const now = nowIso();
  const result = db
    .prepare("INSERT INTO users (email, password_hash, role, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?)")
    .run(email, await hashPassword(password), first ? "admin" : "user", now, checked ? now : null);
  const userId = Number(result.lastInsertRowid);
  // An address checked on the way in that's on a rewarded domain has earned the reward already.
  const rewarded = checked && !!rewardDomain(email) && !db.prepare("SELECT 1 FROM users WHERE lower(bonus_email) = ?").get(email);
  if (rewarded) db.prepare("UPDATE users SET bonus_email = ?, bonus_verified_at = ? WHERE id = ?").run(email, now, userId);
  startSession(c, userId);
  // Otherwise such an address is offered the (optional) check that earns the reward.
  return c.json({ ok: true, bonusEligible: !first && !rewarded && mailMode !== "off" && !!rewardDomain(email) });
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

  // With two-step verification on, the password only opens the second step (server/two-step.ts).
  if (twoStepOn(user.id)) return c.json({ ok: true, twoStep: startSecondStep(user.id, email) });
  failures.delete(email);
  startSession(c, user.id);
  return c.json({ ok: true });
});

// ── The second step: a code from the app, a recovery code, or a passkey ──

const SIGN_IN_AGAIN = "That sign-in has run out. Sign in again";

/** The ticket from the password, if it's still good, the account still on and not locked. */
function secondStep(ticket: unknown) {
  const entry = ticketOf(ticket);
  if (!entry) return { error: SIGN_IN_AGAIN, status: 410 as const };
  if (locked(failures.get(entry.email))) return { error: TOO_MANY, status: 429 as const };
  const user = db.prepare("SELECT disabled FROM users WHERE id = ?").get(entry.userId) as { disabled: number } | undefined;
  if (!user || user.disabled) return { error: "This account is turned off. Ask an admin", status: 403 as const };
  return { entry, ticket: String(ticket) };
}

authRoutes.post("/login/code", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const step = secondStep(body.ticket);
  if (!step.entry) return c.json({ error: step.error }, step.status);
  const how = finishWithCode(step.ticket, step.entry, body.code);
  if (!how) {
    noteFailure(step.entry.email, failures.get(step.entry.email));
    return c.json({ error: "That code isn't right", field: "code" }, 400);
  }
  failures.delete(step.entry.email);
  startSession(c, step.entry.userId);
  // A recovery code used: the page says how many are left.
  return c.json({ ok: true, recoveryLeft: how === "recovery" ? twoStepOf(step.entry.userId).recoveryLeft : null });
});

authRoutes.post("/login/passkey/options", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const step = secondStep(body.ticket);
  if (!step.entry) return c.json({ error: step.error }, step.status);
  return c.json({ options: await signInPasskeyOptions(c, step.entry) });
});

authRoutes.post("/login/passkey", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const step = secondStep(body.ticket);
  if (!step.entry) return c.json({ error: step.error }, step.status);
  if (!(await finishWithPasskey(c, step.ticket, step.entry, body.response))) {
    noteFailure(step.entry.email, failures.get(step.entry.email));
    return c.json({ error: "That passkey didn't work. Try again, or use a code" }, 400);
  }
  failures.delete(step.entry.email);
  startSession(c, step.entry.userId);
  return c.json({ ok: true });
});

authRoutes.post("/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});

authRoutes.get("/me", requireUser, (c) => c.json({ user: c.var.user }));

// ── Where you're signed in (server/sessions.ts) ──

authRoutes.get("/sessions", requireUser, (c) => {
  return c.json({ sessions: sessionsOf(c.var.user!.id, c.var.sessionId), limit: getSettings().maxSessions });
});

/** Signs out every device but this one. */
authRoutes.delete("/sessions", requireUser, (c) => {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(c.var.user!.id, c.var.sessionId);
  return c.json({ ok: true });
});

/** Signs out one device; this one too, the same as signing out. */
authRoutes.delete("/sessions/:id", requireUser, (c) => {
  const ref = c.req.param("id");
  if (ref === sessionRef(c.var.sessionId!)) {
    endSession(c);
    return c.json({ ok: true, signedOut: true });
  }
  if (!endSessionByRef(c.var.user!.id, ref)) return c.json({ error: "That device is already signed out" }, 404);
  return c.json({ ok: true, signedOut: false });
});

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
  // Sign out every other device, then keep this one signed in with a fresh session. A reset link
  // asked for before the change stops working too.
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM password_resets WHERE user_id = ?").run(userId);
  startSession(c, userId);
  return c.json({ ok: true });
});

// ── Forgotten passwords: a link by email to set a new one (server/password-reset.ts) ──

authRoutes.post("/forgot", async (c) => {
  const origin = linkOrigin(c);
  if (!origin) return c.json({ error: "Email isn't set up on this site. Ask an admin" }, 503);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
  const wait = tooSoon(email, clientAddress(c));
  if (wait) return c.json({ error: wait }, 429);
  sendResetLink(email, origin);
  // The same answer whether or not an account uses the address.
  return c.json({ ok: true, resendIn: RESEND_AFTER_S, mail: mailMode });
});

const OFF = "This account is turned off. Ask an admin";

// The reset page asks first, so it can say a link is dead before anyone types a new password.
authRoutes.post("/reset/check", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const reset = findReset(String(body.token ?? ""));
  if (!reset) return c.json({ error: DEAD_LINK }, 410);
  if (reset.disabled) return c.json({ error: OFF }, 403);
  return c.json({ email: reset.email });
});

authRoutes.post("/reset", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const password = String(body.password ?? "");
  // Checked before the link is used up, so a short password doesn't cost it.
  if (password.length < MIN_PASSWORD) return c.json({ error: `Use at least ${MIN_PASSWORD} characters for the password` }, 400);
  const reset = takeReset(String(body.token ?? ""));
  if (!reset) return c.json({ error: DEAD_LINK }, 410);
  if (reset.disabled) return c.json({ error: OFF }, 403);

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), reset.userId);
  // Whoever had the old password is signed out everywhere; the person who set the new one is in.
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.userId);
  clearFailures(reset.email);
  // A link by email doesn't get round two-step verification: they sign in, second step and all.
  if (twoStepOn(reset.userId)) return c.json({ ok: true, signIn: true });
  startSession(c, reset.userId);
  return c.json({ ok: true });
});

// What new chats start with: the persona picked for them (set under Settings › Personas).
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
