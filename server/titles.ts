// Names chats by what they're about. The first title is the opening message's first line; once a
// reply is in, the chat's own model writes a short summary title, and again after the fourth
// exchange so a chat that wandered gets a title that covers it. A chat someone renamed is left alone.
import { getConversation, pathTo } from "./chat-store.ts";
import { decryptSecret } from "./crypto.ts";
import { db, nowIso } from "./db.ts";
import type { KeyRow } from "./keys.ts";
import { estimateCost } from "./providers/catalog.ts";
import { getProvider } from "./providers/index.ts";

/** Exchanges after which the title is (re)written. */
const RETITLE_AT = new Set([1, 4]);
const MAX_MESSAGES = 8;
const MAX_CHARS_PER_MESSAGE = 1500;

const SYSTEM = [
  "You name chats. Write a short title, two to six words, for the conversation you're given.",
  "Use the language the person writes in.",
  "Sentence case: capitalise only the first word and proper nouns.",
  "No quotation marks, no emoji, no full stop at the end.",
  "Reply with the title and nothing else.",
].join(" ");

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Makes whatever came back fit the house rules: one line, no quotes or Markdown, no closing full
 * stop, not Title Case, at most 60 characters.
 */
export function cleanTitle(raw: string): string {
  let title = (raw.split("\n").find((l) => l.trim()) ?? "")
    .replace(/^\s*(title|标题|題名)\s*[:：]\s*/i, "")
    .replace(/[*_`#>]/g, "")
    .replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。]+$/u, "")
    .trim();

  // Title Case ("How To Fix Login Errors") becomes sentence case; acronyms and words with
  // capitals inside them (iPhone, GitHub, API) are kept as they are.
  const words = title.split(" ");
  const titleCased = words.length >= 3 && words.every((w) => /^[A-Z][a-z'’-]*$/.test(w) || !/^[A-Za-z]/.test(w));
  if (titleCased) title = words.map((w, i) => (i === 0 || !/^[A-Z][a-z'’-]*$/.test(w) ? w : w.toLowerCase())).join(" ");

  if (title.length > 60) {
    const cut = title.slice(0, 60);
    const space = cut.lastIndexOf(" ");
    title = space > 30 ? cut.slice(0, space) : cut;
  }
  return title;
}

/**
 * Writes a new title when the branch on screen has just reached one of the re-title points.
 * Returns the new title, or null when nothing changed. Never throws: a failed title just keeps
 * the old one.
 */
export async function maybeRetitle(convId: string, userId: number, key: KeyRow, headId: number): Promise<string | null> {
  try {
    const conv = getConversation(convId);
    if (!conv || !conv.title_auto) return null;

    const answered = pathTo(headId).filter((m, i, path) => {
      if (m.role === "assistant") return m.in_context === 1;
      return path[i + 1]?.role === "assistant" && path[i + 1].in_context === 1;
    });
    const exchanges = answered.filter((m) => m.role === "assistant").length;
    if (!RETITLE_AT.has(exchanges)) return null;

    const transcript = answered
      .slice(0, MAX_MESSAGES)
      .map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${clip(m.text, MAX_CHARS_PER_MESSAGE)}`)
      .join("\n\n");

    const result = await getProvider(key.provider).complete({
      apiKey: decryptSecret(key.encrypted_key),
      model: key.model,
      system: SYSTEM,
      prompt: `<conversation>\n${transcript}\n</conversation>`,
      signal: AbortSignal.timeout(45_000),
    });
    if (!result) return null;

    // Naming the chat costs tokens too, so it counts like any reply.
    db.prepare(
      `INSERT INTO usage_events (user_id, api_key_id, key_label, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      key.id,
      key.label,
      key.provider,
      result.model,
      result.usage.input,
      result.usage.output,
      result.usage.cacheRead,
      result.usage.cacheWrite,
      estimateCost(key.provider, key.model, result.usage),
      nowIso(),
    );

    const title = cleanTitle(result.text);
    if (!title) return null;
    // Someone may have renamed the chat while the title was being written.
    const changed = db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title_auto = 1").run(title, convId);
    return changed.changes ? title : null;
  } catch (err) {
    console.error(`[title] couldn't name chat ${convId}:`, (err as Error).message);
    return null;
  }
}
