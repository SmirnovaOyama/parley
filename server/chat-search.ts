// Searching a person's own chats, by title and by what was said in them. Each word is matched
// anywhere inside the text, so a run of Chinese or Japanese is found with no word breaks.
//
// This reads through the person's own messages instead of a full-text index like the knowledge
// bases'. An index covers everyone's messages, so a common word means sorting through the whole
// site's matches for one person's: about a second at 100,000 messages, and it grows with the site.
// It also has to forget deleted messages at once, as the database does (secure_delete, see db.ts),
// which took seconds for a single chat. Reading one person's messages takes tens of milliseconds
// even at 50 million characters, and grows only with what they've written.
import { db } from "./db.ts";

const MAX_QUERY_CHARS = 200;
const MAX_WORDS = 8;
const MAX_RESULTS = 50;
/**
 * How much of a message a result shows, in the width of a letter (a Chinese character or an emoji
 * takes two): a little before the first match, so it's on the first line even on a phone, and this
 * much in all.
 */
const SNIPPET_BEFORE = 24;
const SNIPPET_WIDTH = 120;

// LIKE ignores case in English letters only. A word with other letters that have a case (Cyrillic,
// Greek, accented Latin) is matched through JavaScript's lower case instead, which is slower.
db.function("has_folded", { deterministic: true }, (text, word) =>
  String(text).toLowerCase().includes(String(word)) ? 1 : 0,
);
const OTHER_CASED = /[^\x00-\x7f]/u;
const needsFolding = (word: string) => [...word].some((ch) => OTHER_CASED.test(ch) && ch.toLowerCase() !== ch.toUpperCase());

export type ChatHit = {
  id: string;
  title: string;
  updatedAt: string;
  projectId: string | null;
  /** The newest matching message, cut around the first match; null when only the title matches. */
  snippet: string | null;
};

/** The words to look for: the query split at spaces, in lower case. */
export function wordsOf(query: string): string[] {
  const words = query.slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)].slice(0, MAX_WORDS);
}

/**
 * This person's chats that have every word of the query in their title or in one of their messages:
 * title matches first, then the rest, each newest first. Chats they deleted are left out, even
 * while admins keep them.
 */
export function searchChats(userId: number, query: string): ChatHit[] {
  const words = wordsOf(query);
  if (!words.length) return [];

  // The newest message in each chat that has all the words.
  const where = ["cv.user_id = ?", "cv.deleted_at IS NULL"];
  const params: (string | number)[] = [userId];
  for (const w of words) {
    if (needsFolding(w)) {
      where.push("has_folded(m.text, ?)");
      params.push(w);
    } else {
      where.push("m.text LIKE ? ESCAPE '\\'");
      params.push(`%${w.replace(/[\\%_]/g, "\\$&")}%`);
    }
  }
  const matched = new Map(
    (
      db
        .prepare(
          `SELECT m.conversation_id AS id, MAX(m.id) AS message_id FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
           WHERE ${where.join(" AND ")} GROUP BY m.conversation_id`,
        )
        .all(...params) as { id: string; message_id: number }[]
    ).map((r) => [r.id, r.message_id]),
  );

  const chats = db
    .prepare("SELECT id, title, updated_at, project_id FROM conversations WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC")
    .all(userId) as { id: string; title: string; updated_at: string; project_id: string | null }[];
  const inTitle = (title: string) => {
    const lower = title.toLowerCase();
    return words.every((w) => lower.includes(w));
  };
  const titled = chats.filter((c) => inTitle(c.title));
  const said = chats.filter((c) => matched.has(c.id) && !inTitle(c.title));

  const textOf = db.prepare("SELECT text FROM messages WHERE id = ?");
  return [...titled, ...said].slice(0, MAX_RESULTS).map((c) => {
    const messageId = matched.get(c.id);
    const text = messageId == null ? null : (textOf.get(messageId) as { text: string }).text;
    return { id: c.id, title: c.title, updatedAt: c.updated_at, projectId: c.project_id, snippet: text == null ? null : snippetOf(text, words) };
  });
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the first of the words appears in the text, ignoring case; the start when none does. */
function firstMatch(text: string, words: string[]): number {
  let at = -1;
  for (const w of words) {
    const found = new RegExp(escapeRegExp(w), "iu").exec(text);
    if (found && (at < 0 || found.index < at)) at = found.index;
  }
  return Math.max(at, 0);
}

/** A stretch of a message as a line of plain text: Markdown's marks and line breaks taken out. */
function plainText(text: string): string {
  return text
    .replace(/```[^\s`]*/g, " ")
    .replace(/!?\[([^[\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\s+/g, " ");
}

/** Chinese, Japanese and Korean characters, and emoji, which take about twice a letter's width. */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\ud800-\udbff]/;
const widthOf = (ch: string) => (WIDE.test(ch) ? 2 : 1);

/**
 * A line of the message around its first match: a little before it, as plain text, with an
 * ellipsis where the message goes on. Only the stretch around the match is read, however long the
 * message is.
 */
export function snippetOf(text: string, words: string[]): string {
  const at = firstMatch(text, words);
  let from = Math.max(0, at - SNIPPET_BEFORE * 4);
  let to = Math.min(text.length, at + SNIPPET_WIDTH * 4);
  // Not halfway through a character that takes two code units (most emoji).
  if (/[\udc00-\udfff]/.test(text[from] ?? "")) from++;
  if (/[\ud800-\udbff]/.test(text[to - 1] ?? "")) to--;
  const flat = plainText(text.slice(from, to));
  const chars = [...flat];
  const hit = [...flat.slice(0, firstMatch(flat, words))].length;

  let start = hit;
  let room = SNIPPET_BEFORE;
  while (start > 0 && (room -= widthOf(chars[start - 1])) >= 0) start--;
  let end = start;
  room = SNIPPET_WIDTH;
  while (end < chars.length && (room -= widthOf(chars[end])) >= 0) end++;
  // Whole words at either end, where it would cut through one (Chinese and Japanese can be cut anywhere).
  const inWord = (i: number) => /[\p{L}\p{N}]/u.test(chars[i] ?? "") && !WIDE.test(chars[i]);
  if (inWord(start - 1) && inWord(start)) {
    const space = chars.indexOf(" ", start);
    if (space >= 0 && space < hit) start = space + 1;
  }
  while (start < hit && /[\s\p{P}]/u.test(chars[start])) start++;
  if (inWord(end - 1) && inWord(end)) {
    const space = chars.lastIndexOf(" ", end);
    if (space > hit) end = space;
  }
  const before = from > 0 || start > 0;
  const after = to < text.length || end < chars.length;
  return `${before ? "…" : ""}${chars.slice(start, end).join("").trim()}${after ? "…" : ""}`;
}
