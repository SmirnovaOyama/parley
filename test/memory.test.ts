// How many notes memory keeps for someone (server/memory.ts): 200, or 1,000 with a verified address
// on a domain the site rewards, for as long as it's rewarded.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { db, nowIso, saveSettings } from "../server/db.ts";
import { MAX_MEMORIES, MAX_MEMORIES_VERIFIED, memoryLimit, saveMemory } from "../server/memory.ts";

function person(email: string, verified: string | null = null): number {
  return Number(
    db
      .prepare("INSERT INTO users (email, password_hash, role, created_at, bonus_email, bonus_verified_at) VALUES (?, 'x', 'user', ?, ?, ?)")
      .run(email, nowIso(), verified, verified ? nowIso() : null).lastInsertRowid,
  );
}

/** Adds notes until the person has `total`. */
function fillTo(userId: number, total: number) {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?").get(userId) as { n: number };
  const add = db.prepare("INSERT INTO memories (user_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)");
  for (let i = n; i < total; i++) add.run(userId, `Note ${i}`, nowIso(), nowIso());
}

const full = (max: number) => ({ error: `Memory is full (${max} notes). Ask the person to delete some under Account first` });

describe("memory limit", () => {
  const pupil = person("pupil@example.com", "pupil@school.edu");

  test("is 200 notes for most people", () => {
    const id = person("someone@example.com");
    assert.equal(memoryLimit(id), MAX_MEMORIES);
    fillTo(id, MAX_MEMORIES - 1);
    assert.ok(!("error" in saveMemory(id, "The last one that fits", null)));
    assert.deepEqual(saveMemory(id, "One too many", null), full(MAX_MEMORIES));
  });

  test("is 1,000 with a verified address on a rewarded domain", () => {
    saveSettings({ bonusDomains: ["school.edu"] });
    assert.equal(memoryLimit(pupil), MAX_MEMORIES_VERIFIED);
    fillTo(pupil, MAX_MEMORIES_VERIFIED - 1);
    assert.ok(!("error" in saveMemory(pupil, "The last one that fits", null)));
    assert.deepEqual(saveMemory(pupil, "One too many", null), full(MAX_MEMORIES_VERIFIED));
  });

  test("goes back to 200 once the domain isn't rewarded, keeping the notes", () => {
    saveSettings({ bonusDomains: [] });
    assert.equal(memoryLimit(pupil), MAX_MEMORIES);
    assert.deepEqual(saveMemory(pupil, "Another", null), full(MAX_MEMORIES));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?").get(pupil) as { n: number }).n, MAX_MEMORIES_VERIFIED);
  });
});
