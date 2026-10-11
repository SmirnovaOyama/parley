// Authenticator-app codes (server/totp.ts), against RFC 6238's own examples.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base32, codeAt, fromBase32, matchCode, otpauthUri, stepNow } from "../server/totp.ts";

// RFC 6238 appendix B: the SHA-1 secret is the ASCII "12345678901234567890".
const SECRET = base32(Buffer.from("12345678901234567890"));

test("base32 goes both ways", () => {
  assert.equal(SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(fromBase32(SECRET).toString(), "12345678901234567890");
  assert.equal(fromBase32("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq").toString(), "12345678901234567890");
});

test("codes match the RFC's, cut to six digits", () => {
  // 94287082 at 59 s, 07081804 at 1111111109 s, 14050471 at 1111111111 s, 89005924 at 1234567890 s.
  for (const [seconds, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"]] as const) {
    assert.equal(codeAt(SECRET, stepNow(seconds * 1000)), code, `at ${seconds} s`);
  }
});

test("a code counts in its step and the ones either side, once", () => {
  const now = 1234567890_000;
  const at = stepNow(now);
  assert.equal(matchCode(SECRET, codeAt(SECRET, at), null, now), at);
  assert.equal(matchCode(SECRET, codeAt(SECRET, at - 1), null, now), at - 1);
  assert.equal(matchCode(SECRET, codeAt(SECRET, at + 1), null, now), at + 1);
  assert.equal(matchCode(SECRET, codeAt(SECRET, at - 2), null, now), null);
  // Used already: not again, nor an earlier one.
  assert.equal(matchCode(SECRET, codeAt(SECRET, at), at, now), null);
  assert.equal(matchCode(SECRET, codeAt(SECRET, at - 1), at, now), null);
  assert.equal(matchCode(SECRET, "12345", null, now), null);
  assert.equal(matchCode(SECRET, ` ${codeAt(SECRET, at).slice(0, 3)} ${codeAt(SECRET, at).slice(3)} `, null, now), at);
});

test("the QR code's address names the site and the account", () => {
  const uri = new URL(otpauthUri("Parley", "a@b.test", SECRET));
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.host, "totp");
  assert.equal(decodeURIComponent(uri.pathname), "/Parley:a@b.test");
  assert.equal(uri.searchParams.get("secret"), SECRET);
  assert.equal(uri.searchParams.get("issuer"), "Parley");
});
