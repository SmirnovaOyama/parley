// Six-digit codes from an authenticator app (RFC 6238): a secret shared once, by QR code, and a
// code from it every 30 seconds. Codes from the step before and after count too, for clocks a
// little apart, and none counts twice: each person's last step used is kept.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_S = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.toUpperCase().replace(/[\s=-]/g, "")) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new secret: 20 random bytes, as authenticator apps expect, in base32. */
export const newSecret = () => base32(randomBytes(20));

/** The code for one 30-second step. */
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, "0");
}

export const stepNow = (now = Date.now()) => Math.floor(now / 1000 / STEP_S);

/**
 * The step a typed code belongs to, if it's this step's, the one before or the one after, and
 * later than `lastStep` (a code is good once); null otherwise.
 */
export function matchCode(secret: string, typed: string, lastStep: number | null, now = Date.now()): number | null {
  const code = typed.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const at = stepNow(now);
  for (const step of [at - 1, at, at + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** What an authenticator app reads from the QR code: the site's name, the account, the secret. */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_S) });
  return `otpauth://totp/${label}?${query}`;
}
