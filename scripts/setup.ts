// Creates .env with a random KEY_ENCRYPTION_SECRET, unless one already exists.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = ".env";
const current = existsSync(path) ? readFileSync(path, "utf8") : "";

if (/^KEY_ENCRYPTION_SECRET=.{32,}$/m.test(current)) {
  console.log(".env already has a KEY_ENCRYPTION_SECRET. Nothing to do.");
} else {
  const lines = [
    current.trimEnd(),
    "# Encrypts the AI API keys stored in the database. Keep it secret and don't change it,",
    "# or saved keys can no longer be read.",
    `KEY_ENCRYPTION_SECRET=${randomBytes(32).toString("base64")}`,
    "",
  ].filter((l, i) => l || i > 0);
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  console.log("Wrote KEY_ENCRYPTION_SECRET to .env");
}
