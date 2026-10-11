// Email rewards. Admins list domains (a school's, a company's); someone who proves they own an
// address on one of them, by typing a code sent to it, earns the bonus: extra tokens or spending
// each month and/or models that aren't open to everyone. It's optional and can be done any time. The reward
// follows the list: if a domain is removed, its addresses stop earning it.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { db, getSettings, nowIso } from "./db.ts";
import { env } from "./env.ts";
import { t, tn } from "./i18n.ts";
import { sendMail } from "./mail.ts";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const SENDS_PER_DAY = 5;
const MAX_ATTEMPTS = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
/** A lower-case host name: labels of letters, digits and hyphens, and a top-level part. */
export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export const normalEmail = (email: string) => email.trim().toLowerCase();

/** The listed domain an address belongs to (its own, or a parent of it), if any. */
export function rewardDomain(email: string, domains = getSettings().bonusDomains): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const host = email.slice(at + 1).toLowerCase();
  return domains.find((d) => host === d || host.endsWith(`.${d}`)) ?? null;
}

export type Bonus = {
  /** The address this person verified, and when; null if they haven't. */
  email: string | null;
  verifiedAt: string | null;
  /** Their verified address is on a domain that's still rewarded. */
  eligible: boolean;
  tokens: number | null;
  /** Dollars a month added to their spending limit. */
  spend: number | null;
  keyIds: number[];
};

export function bonusOf(userId: number): Bonus {
  const settings = getSettings();
  const row = db.prepare("SELECT bonus_email, bonus_verified_at FROM users WHERE id = ?").get(userId) as
    | { bonus_email: string | null; bonus_verified_at: string | null }
    | undefined;
  const email = row?.bonus_email ?? null;
  return {
    email,
    verifiedAt: row?.bonus_verified_at ?? null,
    eligible: !!email && !!rewardDomain(email, settings.bonusDomains),
    tokens: settings.bonusTokens,
    spend: settings.bonusSpend,
    keyIds: settings.bonusKeyIds,
  };
}

const hashCode = (userId: number, email: string, code: string) =>
  createHash("sha256").update(`${userId}:${email}:${code}`).digest();

type CodeRow = { email: string; code_hash: string; expires_at: string; attempts: number; sent_at: string; day: string; sends_today: number };

/** A problem the person can act on, with the HTTP status to answer with. */
export class BonusError extends Error {
  readonly status: 400 | 404 | 409 | 429 | 503;
  constructor(message: string, status: BonusError["status"]) {
    super(message);
    this.status = status;
  }
}

function takenByOther(userId: number, email: string): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE lower(bonus_email) = ? AND id != ?").get(email, userId);
}

/** Emails a fresh 6-digit code to `rawEmail`. Returns when another may be asked for. */
export async function sendCode(userId: number, rawEmail: string): Promise<{ email: string; resendInMs: number }> {
  const email = normalEmail(rawEmail);
  if (!EMAIL_RE.test(email)) throw new BonusError(t("Enter a valid email address"), 400);
  if (!rewardDomain(email)) throw new BonusError(t("That address isn't on a domain that earns a reward here"), 400);
  if (takenByOther(userId, email)) throw new BonusError(t("That address is already verified on another account"), 409);

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const prev = db.prepare("SELECT * FROM email_codes WHERE user_id = ?").get(userId) as CodeRow | undefined;
  if (prev) {
    const wait = Date.parse(prev.sent_at) + RESEND_AFTER_MS - now;
    if (wait > 0) throw new BonusError(t("Wait {ceil} seconds before asking for another code", { ceil: Math.ceil(wait / 1000) }), 429);
    if (prev.day === today && prev.sends_today >= SENDS_PER_DAY) {
      throw new BonusError(t("That's {SENDS_PER_DAY} codes today. Try again tomorrow", { SENDS_PER_DAY }), 429);
    }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await sendMail({
    to: email,
    subject: t("Your {appName} code: {code}", { appName: env.appName, code }),
    text: t(
      "Your code is {code}\n\nType it on the {appName} page where you asked for it. It works for 10 minutes.\n\nIf you didn't ask for this, you can ignore this email.",
      { code, appName: env.appName },
    ),
  }).catch((err) => {
    console.error("[mail] sending failed:", err);
    throw new BonusError(t("Couldn't send the email. Try again in a moment"), 503);
  });

  const sendsToday = prev && prev.day === today ? prev.sends_today + 1 : 1;
  db.prepare(
    `INSERT INTO email_codes (user_id, email, code_hash, expires_at, attempts, sent_at, day, sends_today)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, day = excluded.day,
       sends_today = excluded.sends_today`,
  ).run(userId, email, hashCode(userId, email, code).toString("hex"), new Date(now + CODE_TTL_MS).toISOString(), nowIso(), today, sendsToday);
  return { email, resendInMs: RESEND_AFTER_MS };
}

/** The address a code is waiting for, and how long until another may be sent. */
export function pendingCode(userId: number): { email: string; resendInMs: number } | null {
  const row = db.prepare("SELECT email, sent_at, expires_at, attempts FROM email_codes WHERE user_id = ?").get(userId) as
    | { email: string; sent_at: string; expires_at: string; attempts: number }
    | undefined;
  // An expired code, or one used up by wrong tries, isn't waiting for anything.
  if (!row || Date.parse(row.expires_at) < Date.now() || row.attempts >= MAX_ATTEMPTS) return null;
  return { email: row.email, resendInMs: Math.max(0, Date.parse(row.sent_at) + RESEND_AFTER_MS - Date.now()) };
}

/** Checks a typed code; on a match the address becomes this person's verified one. */
export function verifyCode(userId: number, rawCode: string): string {
  const code = rawCode.replace(/\s+/g, "");
  const row = db.prepare("SELECT * FROM email_codes WHERE user_id = ?").get(userId) as CodeRow | undefined;
  if (!row) throw new BonusError(t("Ask for a code first"), 400);
  if (Date.parse(row.expires_at) < Date.now()) throw new BonusError(t("That code has expired. Send a new one"), 400);
  if (row.attempts >= MAX_ATTEMPTS) throw new BonusError(t("Too many wrong codes. Send a new one"), 429);

  const expected = Buffer.from(row.code_hash, "hex");
  const ok = /^\d{6}$/.test(code) && timingSafeEqual(expected, hashCode(userId, row.email, code));
  if (!ok) {
    db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?").run(userId);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    throw new BonusError(
      left > 0 ? tn(left, "That code isn't right. {left} try left", "That code isn't right. {left} tries left", { left }) : t("Too many wrong codes. Send a new one"),
      left > 0 ? 400 : 429,
    );
  }
  // The domain list or another account may have changed since the code was sent.
  if (!rewardDomain(row.email)) throw new BonusError(t("That address's domain no longer earns a reward here"), 400);
  if (takenByOther(userId, row.email)) throw new BonusError(t("That address is already verified on another account"), 409);

  db.prepare("UPDATE users SET bonus_email = ?, bonus_verified_at = ? WHERE id = ?").run(row.email, nowIso(), userId);
  db.prepare("DELETE FROM email_codes WHERE user_id = ?").run(userId);
  return row.email;
}
