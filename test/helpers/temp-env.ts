// A throwaway database and secret for tests that load server code: server/env.ts reads them as it
// loads, and server/db.ts opens the database. Import this before anything from server/ that does.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDir = mkdtempSync(join(tmpdir(), "parley-test-"));
process.env.DATABASE_PATH = join(tempDir, "chat.db");
process.env.KEY_ENCRYPTION_SECRET = randomBytes(24).toString("hex");
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
