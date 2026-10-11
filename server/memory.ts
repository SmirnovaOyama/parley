// Memory: short notes the AI keeps about a person between chats. The model saves and deletes them
// with its memory tool when the person shares something lasting or asks it to; the person sees,
// edits and deletes them under Settings. New chats start with them in their system prompt.
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

/** The note already kept with these words, whatever their case. */
export const keptMemory = (userId: number, text: string) =>
  db.prepare("SELECT * FROM memories WHERE user_id = ? AND lower(text) = lower(?)").get(userId, text) as MemoryRow | undefined;

/** A note's words as compared for repeats: lower case, without spaces, punctuation or symbols. */
const bareWords = (text: string) => [...text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "")];

/**
 * How alike two notes read, from 0 to 1: the share of their two-character pieces they have in
 * common, or 1 when one holds the other whole. Works the same for Chinese and for English.
 */
export function likeness(a: string, b: string): number {
  const x = bareWords(a), y = bareWords(b);
  if (!x.length || !y.length) return 0;
  const xs = x.join(""), ys = y.join("");
  if (xs.includes(ys) || ys.includes(xs)) return 1;
  const pairs = (chars: string[]) => new Set(chars.slice(1).map((c, i) => chars[i] + c));
  const p = pairs(x), q = pairs(y);
  let both = 0;
  for (const pair of p) if (q.has(pair)) both++;
  return p.size + q.size ? (2 * both) / (p.size + q.size) : 0;
}

/** Notes this alike or more may say the same thing. */
const ALIKE = 0.55;
/** Notes listed for the model to check against, at most. */
const MAX_TO_CHECK = 30;

/**
 * The notes a new one may repeat, for the model to look over before it's kept: those that read
 * alike, and those this chat's model hasn't seen, since a note in other words or another language
 * can say the same thing. Unseen means not in the chat's system prompt as it is now: kept or edited
 * since the chat began, in this chat or another. (A note saved earlier in this chat may not be in
 * front of the model any more: some providers only get the replies' words back.)
 */
export function notesToCheck(userId: number, text: string, systemPrompt: string): { note: MemoryRow; unseen: boolean }[] {
  return memoriesOf(userId)
    .map((note) => ({ note, alike: likeness(text, note.text), unseen: !systemPrompt.includes(`\n[${note.id}] ${note.text}\n`) }))
    .filter((n) => n.alike >= ALIKE || n.unseen)
    .sort((a, b) => b.alike - a.alike || b.note.id - a.note.id)
    .slice(0, MAX_TO_CHECK)
    .map(({ note, unseen }) => ({ note, unseen }));
}

/** What the model is told when a note it wants to save may repeat one it has. */
export function checkFirst(notes: { note: MemoryRow; unseen: boolean }[]): string {
  return [
    "Not saved yet. Make sure it doesn't repeat a note the person already has, even in other words or another language. These may say the same thing:",
    ...notes.map(({ note, unseen }) => `[${note.id}] ${note.text}${unseen ? " (kept or changed after this chat began)" : ""}`),
    "If one of them already says it, don't save it. If it corrects or adds to one, delete that note, then save the new one. If it's something new, save the same text again.",
  ].join("\n");
}

/** A sentence for the model when this person's memory has no room for another note. */
export function memoryFull(userId: number): string | null {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?").get(userId) as { n: number };
  const max = memoryLimit(userId);
  return n >= max ? `Memory is full (${max} notes). Ask the person to delete some under Settings first` : null;
}

/** Saves a note, or finds the same one already kept. A sentence comes back when there's no room. */
export function saveMemory(userId: number, text: string, conversationId: string | null): MemoryRow | { error: string } {
  const same = keptMemory(userId, text);
  if (same) return same;
  const full = memoryFull(userId);
  if (full) return { error: full };
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
