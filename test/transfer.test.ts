// Bringing in an export (server/transfer.ts): what a file says is taken only as far as the site's
// own rules allow, so an import can't do what the pages and the AI can't.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { db, nowIso, saveSettings } from "../server/db.ts";
import { MAX_INSTRUCTION_CHARS } from "../server/instructions.ts";
import { MAX_MEMORIES } from "../server/memory.ts";
import { MAX_PROJECTS } from "../server/projects.ts";
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

describe("import limits", () => {
  const count = (table: string, userId: number) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number }).n;

  test("bring in projects only while there's room, and chats in the rest without one", () => {
    const id = person("projects@example.com");
    const add = db.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)");
    for (let i = 0; i < MAX_PROJECTS - 1; i++) add.run(randomUUID(), id, `Project ${i}`, nowIso(), nowIso());
    const result = importFor(id, exportOf({
      projects: [
        { id: "p0", name: "Project 0", instructions: "", createdAt: nowIso() },
        { id: "p1", name: "Fits", instructions: "", createdAt: nowIso() },
        { id: "p2", name: "No room", instructions: "", createdAt: nowIso() },
      ],
      chats: [{ ...chat("In the old one", nowIso()), projectId: "p0" }, { ...chat("In one left out", nowIso()), projectId: "p2" }],
    }));
    assert.equal(result.projects, 1);
    assert.equal(count("projects", id), MAX_PROJECTS);
    const projectOf = (title: string) => (db.prepare("SELECT p.name FROM conversations c LEFT JOIN projects p ON p.id = c.project_id WHERE c.user_id = ? AND c.title = ?").get(id, title) as { name: string | null }).name;
    assert.equal(projectOf("In the old one"), "Project 0");
    assert.equal(projectOf("In one left out"), null);
  });

  test("hold a chat's own instructions to the length the settings page allows", () => {
    const id = person("instructions@example.com");
    importFor(id, exportOf({ chats: [{ ...chat("Long", nowIso()), instructions: { aboutMe: "a".repeat(100_000), answerStyle: ` ${"b".repeat(2000)} ` } }] }));
    const row = db.prepare("SELECT chat_instructions, system_prompt FROM conversations WHERE user_id = ?").get(id) as { chat_instructions: string; system_prompt: string };
    const kept = JSON.parse(row.chat_instructions);
    assert.equal(kept.aboutMe, "a".repeat(MAX_INSTRUCTION_CHARS));
    assert.equal(kept.answerStyle, "b".repeat(MAX_INSTRUCTION_CHARS));
    assert.ok(!row.system_prompt.includes("a".repeat(MAX_INSTRUCTION_CHARS + 1)));
  });

  test("bring in notes until memory is full, without counting ones kept already", () => {
    const id = person("notes@example.com");
    const add = db.prepare("INSERT INTO memories (user_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < MAX_MEMORIES - 2; i++) add.run(id, `Note ${i}`, nowIso(), nowIso());
    const notes = ["Note 0", "Likes tea", "Lives in Leeds", "One too many", ...Array.from({ length: 50_000 }, (_, i) => `Extra ${i}`)];
    const started = Date.now();
    const result = importFor(id, exportOf({ memories: notes.map((text) => ({ text, createdAt: nowIso() })) }));
    // It stops once memory is full, rather than looking up each of the 50,000 notes left (seconds).
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.equal(result.memories, 2);
    assert.equal(count("memories", id), MAX_MEMORIES);
    assert.equal(db.prepare("SELECT 1 FROM memories WHERE user_id = ? AND text = 'One too many'").get(id), undefined);
  });
});

test("deleted rows are zeroed in the database file", () => {
  assert.deepEqual({ ...(db.prepare("PRAGMA secure_delete").get() as object) }, { secure_delete: 1 });
});
