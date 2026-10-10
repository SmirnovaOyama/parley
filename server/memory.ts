// Memory: short notes the AI keeps about a person between chats. The model saves and deletes them
// with its memory tool when the person shares something lasting or asks it to; the person sees,
// edits and deletes them under Account. New chats start with them in their system prompt.
import { bonusOf } from "./bonus.ts";
import { db, getSettings, nowIso } from "./db.ts";

export const MAX_MEMORIES = 200;
/** Someone with a verified address on a rewarded domain (bonus.ts) keeps more, while it's rewarded. */
export const MAX_MEMORIES_VERIFIED = 1000;
export const MAX_MEMORY_CHARS = 500;

/** How many notes this person can keep. */
export const memoryLimit = (userId: number) => (bonusOf(userId).eligible ? MAX_MEMORIES_VERIFIED : MAX_MEMORIES);

export type MemoryRow = { id: number; user_id: number; text: string; conversation_id: string | null; created_at: string; updated_at: string };

/** Whether the AI remembers things for this person: the site allows it and they haven't turned it off. */
export function memoryOn(userId: number): boolean {
  if (!getSettings().memory) return false;
  const row = db.prepare("SELECT memory_off FROM users WHERE id = ?").get(userId) as { memory_off: number } | undefined;
  return !!row && !row.memory_off;
}

export function memoriesOf(userId: number): MemoryRow[] {
  return db.prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY id").all(userId) as MemoryRow[];
}

/** One line, trimmed, within the limit; empty when there's nothing to keep. */
export const cleanMemory = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);

/** Saves a note, or finds the same one already kept. A sentence comes back when there's no room. */
export function saveMemory(userId: number, text: string, conversationId: string | null): MemoryRow | { error: string } {
  const same = db.prepare("SELECT * FROM memories WHERE user_id = ? AND lower(text) = lower(?)").get(userId, text) as MemoryRow | undefined;
  if (same) return same;
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?").get(userId) as { n: number };
  const max = memoryLimit(userId);
  if (n >= max) return { error: `Memory is full (${max} notes). Ask the person to delete some under Account first` };
  const now = nowIso();
  const id = Number(
    db.prepare("INSERT INTO memories (user_id, text, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(userId, text, conversationId, now, now)
      .lastInsertRowid,
  );
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow;
}

export function deleteMemory(userId: number, id: number): boolean {
  return db.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/**
 * What a new chat is told about memory: the notes kept so far (with their ids, so the model can
 * delete one) and when to save more. Only for chats that start with memory on.
 */
export function memoryPrompt(userId: number): string {
  const notes = memoriesOf(userId);
  const list = notes.length
    ? `<memory>\n${notes.map((m) => `[${m.id}] ${m.text}`).join("\n")}\n</memory>\n\nThese are notes you kept about the person in earlier chats. Use them where they help, without announcing that you remember.`
    : "You have no notes about the person yet.";
  return [
    list,
    "You can keep notes between chats with the memory tool. Save a short note when the person shares a lasting fact or preference that will help in later chats, or asks you to remember something; delete one when it turns out wrong or they ask you to forget it. Don't save passing details, and don't save sensitive personal information unless they ask you to. The person can see and edit these notes.",
  ].join("\n\n");
}
