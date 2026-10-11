// Codes that check a new account's address before it's made: the sign-up page asks for one, it's
// emailed, and the account is made only with it. That keeps out made-up addresses, and accounts
// made by the dozen to pass the site's keys on. Admins turn it on or off in Settings; left alone,
// it's on once the site can send email. The site's first account, which sets it up, needs none.
// One code per address, hashed, good for 10 minutes and 5 tries; asking is limited by address and
// by network.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { db, getSettings, nowIso } from "./db.ts";
import { env } from "./env.ts";
import { t, tn } from "./i18n.ts";
import { mailMode, sendMail } from "./mail.ts";
import { recent } from "./password-reset.ts";

const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_AFTER_S = 60;
const SENDS_PER_DAY = 5;
const MAX_ATTEMPTS = 5;
const ASKS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

const byNetwork = recent(HOUR_MS);

/** Whether making an account takes a code: when the admins say so, or by default once email goes out. */
export function signupNeedsCode(): boolean {
  if (mailMode === "off") return false;
  return getSettings().signupCode ?? mailMode === "smtp";
}

/** A problem the person can act on, with the HTTP status to answer with. */
export class SignupCodeError extends Error {
  readonly status: 400 | 429 | 503;
  constructor(message: string, status: SignupCodeError["status"]) {
    super(message);
    this.status = status;
  }
}

// Keyed with the site's secret: six digits alone would be quick to try against a copied database.
const hashCode = (email: string, code: string) => createHmac("sha256", env.keyEncryptionSecret).update(`signup:${email}:${code}`).digest();

type CodeRow = { email: string; code_hash: string; expires_at: string; attempts: number; sent_at: string; day: string; sends_today: number };

/** Emails a fresh 6-digit code to `email` (already checked and lower-cased), asked for from `network`. */
export async function sendSignupCode(email: string, network: string): Promise<void> {
  const now = Date.now();
  if (byNetwork.of(network, now).length >= ASKS_PER_HOUR) {
    throw new SignupCodeError(t("Too many codes asked for from here. Try again in an hour"), 429);
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const prev = db.prepare("SELECT * FROM signup_codes WHERE email = ?").get(email) as CodeRow | undefined;
  if (prev) {
    const wait = Date.parse(prev.sent_at) + RESEND_AFTER_S * 1000 - now;
    if (wait > 0) throw new SignupCodeError(t("Wait {ceil} seconds before asking for another code", { ceil: Math.ceil(wait / 1000) }), 429);
    if (prev.day === today && prev.sends_today >= SENDS_PER_DAY) {
      throw new SignupCodeError(t("That's {SENDS_PER_DAY} codes for this address today. Try again tomorrow", { SENDS_PER_DAY }), 429);
    }
  }
  byNetwork.note(network, now);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await sendMail({
    to: email,
    subject: t("Your {appName} code: {code}", { appName: env.appName, code }),
    text: t(
      "Your code to create your {appName} account is {code}\n\nType it on the sign-up page. It works for 10 minutes.\n\nIf you didn't ask for this, you can ignore this email: no account is made without the code.",
      { appName: env.appName, code },
    ),
  }).catch((err) => {
    console.error("[mail] sending failed:", err);
    throw new SignupCodeError(t("Couldn't send the email. Try again in a moment"), 503);
  });

  const sendsToday = prev && prev.day === today ? prev.sends_today + 1 : 1;
  db.prepare(
    `INSERT INTO signup_codes (email, code_hash, expires_at, attempts, sent_at, day, sends_today)
     VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
       sent_at = excluded.sent_at, day = excluded.day, sends_today = excluded.sends_today`,
  ).run(email, hashCode(email, code).toString("hex"), new Date(now + CODE_TTL_MS).toISOString(), nowIso(), today, sendsToday);
}

/** Checks the code typed for `email`; a match is used up. */
export function takeSignupCode(email: string, rawCode: unknown): void {
  const code = String(rawCode ?? "").replace(/\s+/g, "");
  const row = db.prepare("SELECT * FROM signup_codes WHERE email = ?").get(email) as CodeRow | undefined;
  if (!row) throw new SignupCodeError(t("Send yourself a code first"), 400);
  if (Date.parse(row.expires_at) < Date.now()) throw new SignupCodeError(t("That code has expired. Send a new one"), 400);
  if (row.attempts >= MAX_ATTEMPTS) throw new SignupCodeError(t("Too many wrong codes. Send a new one"), 429);

  const ok = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(row.code_hash, "hex"), hashCode(email, code));
  if (!ok) {
    db.prepare("UPDATE signup_codes SET attempts = attempts + 1 WHERE email = ?").run(email);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    throw new SignupCodeError(
      left > 0 ? tn(left, "That code isn't right. {left} try left", "That code isn't right. {left} tries left", { left }) : t("Too many wrong codes. Send a new one"),
      left > 0 ? 400 : 429,
    );
  }
  // Used once; and a day's count of sends goes with it, since the account is made.
  db.prepare("DELETE FROM signup_codes WHERE email = ?").run(email);
}

/** Codes past their time, gone. */
export function clearStaleSignupCodes() {
  db.prepare("DELETE FROM signup_codes WHERE expires_at < ? AND day < ?").run(nowIso(), new Date().toISOString().slice(0, 10));
}
