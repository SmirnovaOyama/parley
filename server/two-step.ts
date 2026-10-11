// Two-step verification: after the password, a code from an authenticator app (server/totp.ts)
// or a passkey, the person's device signing for them. It's on while either is set up. Turning it
// on gives ten one-time recovery codes, for a lost phone. Setting up and removing either takes the
// password again (server/routes/two-step.ts); an admin can turn it all off for someone locked out.
//
// Signing in with it on is two requests: the password gives a ticket good for five minutes and five
// tries, and the ticket with a code, a recovery code or a passkey's answer gives the session.
import { createHmac, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Context } from "hono";
import QRCode from "qrcode";
import { originOf } from "./auth.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";
import { base32, matchCode, newSecret, otpauthUri } from "./totp.ts";

const PENDING_MS = 10 * 60 * 1000;
const TICKET_MS = 5 * 60 * 1000;
const TICKET_TRIES = 5;
const RECOVERY_CODES = 10;
const MAX_TRACKED = 10_000;

type PasskeyRow = { id: string; public_key: Buffer; counter: number; transports: string | null; name: string; created_at: string; last_used_at: string | null };

export type TwoStep = {
  on: boolean;
  totp: boolean;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  /** Recovery codes not used yet. */
  recoveryLeft: number;
};

const passkeysOf = (userId: number) =>
  db.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at").all(userId) as PasskeyRow[];

const hasTotp = (userId: number) => !!(db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(userId) as { totp_secret: string | null } | undefined)?.totp_secret;

export function twoStepOf(userId: number): TwoStep {
  const totp = hasTotp(userId);
  const passkeys = passkeysOf(userId).map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at, lastUsedAt: p.last_used_at }));
  const { left } = db.prepare("SELECT COUNT(*) AS left FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId) as { left: number };
  return { on: totp || passkeys.length > 0, totp, passkeys, recoveryLeft: left };
}

export const twoStepOn = (userId: number) => twoStepOf(userId).on;

/** Turns it all off, for someone locked out (an admin does this). */
export function turnOffTwoStep(userId: number) {
  db.prepare("UPDATE users SET totp_secret = NULL, totp_last_step = NULL, totp_added_at = NULL WHERE id = ?").run(userId);
  db.prepare("DELETE FROM passkeys WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
}

/** Small maps of things waiting a few minutes; past their time, or past MAX_TRACKED, they go. */
function waiting<T extends { expires: number }>() {
  const map = new Map<string, T>();
  return {
    get(key: string): T | undefined {
      const v = map.get(key);
      if (v && v.expires < Date.now()) map.delete(key);
      return v && v.expires >= Date.now() ? v : undefined;
    },
    set(key: string, value: T) {
      map.set(key, value);
      if (map.size <= MAX_TRACKED) return;
      for (const [k, v] of map) if (v.expires < Date.now()) map.delete(k);
      for (const k of map.keys()) {
        if (map.size <= MAX_TRACKED) break;
        map.delete(k);
      }
    },
    delete: (key: string) => map.delete(key),
  };
}

// ── Recovery codes ──

const hashRecovery = (userId: number, code: string) =>
  createHmac("sha256", env.keyEncryptionSecret).update(`recovery:${userId}:${code.toLowerCase().replace(/[^a-z2-7]/g, "")}`).digest("hex");

/** Ten new codes in place of any before, like "k4m2p-7qx3a". Shown once; only their hashes are kept. */
export function newRecoveryCodes(userId: number): string[] {
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
  const add = db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
  for (const code of codes) add.run(userId, hashRecovery(userId, code));
  return codes;
}

function useRecoveryCode(userId: number, typed: string): boolean {
  return db.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").run(nowIso(), userId, hashRecovery(userId, typed)).changes > 0;
}

/** When the first way of the second step is added: recovery codes to go with it, if none are left. */
const recoveryForFirst = (userId: number, wasOn: boolean): string[] | null => (wasOn && twoStepOf(userId).recoveryLeft > 0 ? null : newRecoveryCodes(userId));

/** The last way removed: the codes go too, and it's off. */
function dropRecoveryIfOff(userId: number) {
  if (!twoStepOn(userId)) db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
}

// ── An authenticator app ──

const pendingTotp = waiting<{ secret: string; expires: number }>();

/** A new secret to scan, as a QR code (an SVG image's data URL) and as text to type in. */
export async function startTotp(userId: number, email: string): Promise<{ secret: string; uri: string; qr: string }> {
  const secret = newSecret();
  pendingTotp.set(String(userId), { secret, expires: Date.now() + PENDING_MS });
  const uri = otpauthUri(env.appName, email, secret);
  const svg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { secret, uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
}

/** Saves the secret once the app's first code checks out; recovery codes come with a first way. */
export function confirmTotp(userId: number, code: string): { ok: false } | { ok: true; recoveryCodes: string[] | null } {
  const pending = pendingTotp.get(String(userId));
  if (!pending) return { ok: false };
  const step = matchCode(pending.secret, code, null);
  if (step == null) return { ok: false };
  const wasOn = twoStepOn(userId);
  db.prepare("UPDATE users SET totp_secret = ?, totp_last_step = ?, totp_added_at = ? WHERE id = ?").run(encryptSecret(pending.secret), step, nowIso(), userId);
  pendingTotp.delete(String(userId));
  return { ok: true, recoveryCodes: recoveryForFirst(userId, wasOn) };
}

export const totpPending = (userId: number) => !!pendingTotp.get(String(userId));

export function removeTotp(userId: number) {
  db.prepare("UPDATE users SET totp_secret = NULL, totp_last_step = NULL, totp_added_at = NULL WHERE id = ?").run(userId);
  dropRecoveryIfOff(userId);
}

/** Checks a code against the saved secret; a match is used up. */
function checkTotp(userId: number, code: string): boolean {
  const row = db.prepare("SELECT totp_secret, totp_last_step FROM users WHERE id = ?").get(userId) as { totp_secret: string | null; totp_last_step: number | null } | undefined;
  if (!row?.totp_secret) return false;
  const step = matchCode(decryptSecret(row.totp_secret), code, row.totp_last_step);
  if (step == null) return false;
  db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ?").run(step, userId);
  return true;
}

// ── Passkeys ──

/**
 * The site a passkey belongs to: PUBLIC_URL when it's set, else the address the browser used. A
 * passkey made for one name doesn't work under another.
 */
function relyingParty(c: Context): { rpID: string; origin: string } {
  const origin = env.publicUrl ?? originOf(c);
  return { rpID: new URL(origin).hostname, origin };
}

/** A stable handle for the person on their passkeys that says nothing about them. */
const userHandle = (userId: number) => new Uint8Array(createHmac("sha256", env.keyEncryptionSecret).update(`passkey-user:${userId}`).digest().subarray(0, 16));

const transportsOf = (row: PasskeyRow) => (row.transports ? (JSON.parse(row.transports) as string[]) : undefined);

const pendingPasskey = waiting<{ challenge: string; expires: number }>();

export async function passkeyOptions(c: Context, userId: number, email: string) {
  const { rpID } = relyingParty(c);
  const options = await generateRegistrationOptions({
    rpName: env.appName,
    rpID,
    userName: email,
    userID: userHandle(userId),
    attestationType: "none",
    excludeCredentials: passkeysOf(userId).map((p) => ({ id: p.id, transports: transportsOf(p) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  pendingPasskey.set(String(userId), { challenge: options.challenge, expires: Date.now() + PENDING_MS });
  return options;
}

/** Saves the passkey the browser made, named for where it was made. */
export async function addPasskey(c: Context, userId: number, response: RegistrationResponseJSON, name: string): Promise<{ ok: false } | { ok: true; recoveryCodes: string[] | null }> {
  const pending = pendingPasskey.get(String(userId));
  if (!pending) return { ok: false };
  pendingPasskey.delete(String(userId));
  const { rpID, origin } = relyingParty(c);
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  }).catch(() => null);
  if (!result?.verified) return { ok: false };
  const { credential } = result.registrationInfo;
  const wasOn = twoStepOn(userId);
  db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    credential.id,
    userId,
    Buffer.from(credential.publicKey),
    credential.counter,
    credential.transports ? JSON.stringify(credential.transports) : null,
    name.slice(0, 80),
    nowIso(),
  );
  return { ok: true, recoveryCodes: recoveryForFirst(userId, wasOn) };
}

export function removePasskey(userId: number, id: string): boolean {
  const removed = db.prepare("DELETE FROM passkeys WHERE user_id = ? AND id = ?").run(userId, id).changes > 0;
  dropRecoveryIfOff(userId);
  return removed;
}

// ── Signing in ──

type Ticket = { userId: number; email: string; expires: number; tries: number; challenge?: string };
const tickets = waiting<Ticket>();

/** After the right password: a ticket for the second step, and which ways it can take. */
export function startSecondStep(userId: number, email: string): { ticket: string; totp: boolean; passkey: boolean } {
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { userId, email, expires: Date.now() + TICKET_MS, tries: 0 });
  const state = twoStepOf(userId);
  return { ticket, totp: state.totp, passkey: state.passkeys.length > 0 };
}

export const ticketOf = (ticket: unknown): Ticket | undefined => (typeof ticket === "string" ? tickets.get(ticket) : undefined);

/** A wrong answer: the ticket goes after its last try. */
function missed(ticket: string, entry: Ticket) {
  entry.tries++;
  if (entry.tries >= TICKET_TRIES) tickets.delete(ticket);
}

/**
 * Checks a six-digit code from the app, or a recovery code. "recovery" says one was used up (the
 * page then says how many are left); null is a miss.
 */
export function finishWithCode(ticket: string, entry: Ticket, code: unknown): "totp" | "recovery" | null {
  const typed = String(code ?? "").trim();
  const how = /^\d[\d\s]*$/.test(typed) ? (checkTotp(entry.userId, typed) ? "totp" : null) : useRecoveryCode(entry.userId, typed) ? "recovery" : null;
  if (!how) missed(ticket, entry);
  else tickets.delete(ticket);
  return how;
}

export async function signInPasskeyOptions(c: Context, entry: Ticket) {
  const { rpID } = relyingParty(c);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeysOf(entry.userId).map((p) => ({ id: p.id, transports: transportsOf(p) })),
    userVerification: "preferred",
  });
  entry.challenge = options.challenge;
  return options;
}

export async function finishWithPasskey(c: Context, ticket: string, entry: Ticket, response: AuthenticationResponseJSON): Promise<boolean> {
  const row = entry.challenge && response?.id ? (db.prepare("SELECT * FROM passkeys WHERE id = ? AND user_id = ?").get(response.id, entry.userId) as PasskeyRow | undefined) : undefined;
  const { rpID, origin } = relyingParty(c);
  const result = row
    ? await verifyAuthenticationResponse({
        response,
        expectedChallenge: entry.challenge!,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: transportsOf(row) },
        requireUserVerification: false,
      }).catch(() => null)
    : null;
  if (!result?.verified) {
    missed(ticket, entry);
    return false;
  }
  db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(result.authenticationInfo.newCounter, nowIso(), row!.id);
  tickets.delete(ticket);
  return true;
}
