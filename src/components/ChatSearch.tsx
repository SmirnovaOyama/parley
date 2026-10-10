import { useEffect, useState } from "react";
import { api, type ChatHit } from "../lib/api.ts";

/** The words a search looks for, as the server splits them: at spaces, in lower case. */
export function searchWords(query: string): string[] {
  return [...new Set(query.slice(0, 200).toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

/**
 * Your chats that match the query, a moment after typing stops. The last results stay while the
 * next ones load, so the list doesn't blink; null before the first ones arrive, or with no query.
 */
export function useChatSearch(query: string): ChatHit[] | null {
  const q = query.trim();
  const [found, setFound] = useState<ChatHit[] | null>(null);

  useEffect(() => {
    if (!q) return;
    let live = true;
    const timer = setTimeout(() => {
      api.get<{ results: ChatHit[] }>(`/conversations/search?q=${encodeURIComponent(q)}`).then(
        (r) => live && setFound(r.results),
        () => live && setFound([]),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  return q ? found : null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text with each of the words marked where it appears, ignoring case. */
export function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return text;
  // Longer words first, so one that contains another is marked whole.
  const pattern = new RegExp(`(${[...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`, "giu");
  return text.split(pattern).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="search-hit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
