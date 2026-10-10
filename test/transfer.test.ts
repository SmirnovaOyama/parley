// Bringing in an export (server/transfer.ts): what a file says is taken only as far as the site's
// own rules allow, so an import can't do what the pages and the AI can't.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { db, nowIso, saveSettings } from "../server/db.ts";
import { enforceRetention } from "../server/retention.ts";
import { EXPORT_FORMAT, importFor } from "../server/transfer.ts";

function person(email: string): number {
  return Number(
    db.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'x', 'user', ?)").run(email, nowIso()).lastInsertRowid,
  );
}

/** A Parley export holding these parts, as the bytes of the file. */
const exportOf = (parts: Record<string, unknown>) => Buffer.from(JSON.stringify({ format: EXPORT_FORMAT, version: 1, chats: [], ...parts }));

/** A chat of one question and answer, last touched when `updatedAt` says. */
const chat = (title: string, updatedAt: unknown) => ({
  id: randomUUID(),
  title,
  projectId: null,
  createdAt: updatedAt,
  updatedAt,
  headId: 2,
  messages: [
    { id: 1, parentId: null, role: "user", text: "Hello", createdAt: updatedAt },
    { id: 2, parentId: 1, role: "assistant", text: "Hi", createdAt: updatedAt },
  ],
});

const updatedAt = (userId: number, title: string) =>
  (db.prepare("SELECT updated_at FROM conversations WHERE user_id = ? AND title = ?").get(userId, title) as { updated_at: string } | undefined)?.updated_at;

describe("import dates", () => {
  test("keep a chat's own past dates, and take now for one still to come or out of range", () => {
    const id = person("dates@example.com");
    const before = nowIso();
    importFor(id, exportOf({ chats: [chat("Old", "2001-02-03T04:05:06.000Z"), chat("Future", "9999-01-01T00:00:00.000Z"), chat("Far off", 1e20), chat("Seconds", 1e9)] }));
    assert.equal(updatedAt(id, "Old"), "2001-02-03T04:05:06.000Z");
    assert.equal(updatedAt(id, "Seconds"), "2001-09-09T01:46:40.000Z");
    for (const title of ["Future", "Far off"]) {
      const at = updatedAt(id, title)!;
      assert.ok(at >= before && at <= nowIso(), `${title}: ${at}`);
    }
  });

  test("count from the import for the retention rules", () => {
    const id = person("retention@example.com");
    importFor(id, exportOf({ chats: [chat("Brought in", "2001-02-03T04:05:06.000Z")] }));
    const old = "2001-02-03T04:05:06.000Z";
    db.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, 'Left alone', ?, ?)").run(randomUUID(), id, old, old);
    saveSettings({ retainChatsDays: 30 });
    try {
      enforceRetention();
    } finally {
      saveSettings({ retainChatsDays: null });
    }
    assert.equal(updatedAt(id, "Brought in"), old);
    assert.equal(updatedAt(id, "Left alone"), undefined);
  });
});

test("deleted rows are zeroed in the database file", () => {
  assert.deepEqual({ ...(db.prepare("PRAGMA secure_delete").get() as object) }, { secure_delete: 1 });
});
