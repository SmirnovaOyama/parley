// Shared links. A link shows one branch of a chat, from the first message down to the message it
// was shared up to. Messages are never rewritten (edits and regenerations add siblings), so that
// branch stays exactly as it was shared, and later messages only appear when the owner updates it.
import { randomBytes } from "node:crypto";
import { pathTo, toPublic, type ConversationRow, type PublicMessage } from "./chat-store.ts";
import { db, nowIso } from "./db.ts";
import { t } from "./i18n.ts";

export type ShareRow = {
  id: string;
  conversation_id: string;
  leaf_id: number;
  title: string;
  created_at: string;
  updated_at: string;
};

export function shareOf(conversationId: string): ShareRow | undefined {
  return db.prepare("SELECT * FROM shares WHERE conversation_id = ?").get(conversationId) as ShareRow | undefined;
}

/** What the owner sees about their link. The link is up to date while leafId is the chat's last message. */
export function shareOut(share: ShareRow) {
  return { token: share.id, leafId: share.leaf_id, sharedAt: share.updated_at };
}

/** Shares the chat as it is on screen now, or moves an existing link up to now. The link stays the same. */
export function shareUpTo(conv: ConversationRow): ShareRow {
  const now = nowIso();
  const existing = shareOf(conv.id);
  if (existing) {
    db.prepare("UPDATE shares SET leaf_id = ?, title = ?, updated_at = ? WHERE id = ?").run(conv.head_id, conv.title, now, existing.id);
  } else {
    db.prepare("INSERT INTO shares (id, conversation_id, leaf_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      randomBytes(16).toString("base64url"),
      conv.id,
      conv.head_id,
      conv.title,
      now,
      now,
    );
  }
  return shareOf(conv.id)!;
}

/** Ends the link for good: sharing again makes a new one. */
export function stopSharing(conversationId: string) {
  db.prepare("DELETE FROM shares WHERE conversation_id = ?").run(conversationId);
}

/**
 * The shared branch for someone outside the chat: the words and which model wrote them. Thinking,
 * notes, instruction markers and error details (which can name keys) stay out.
 */
export function sharedMessages(leafId: number): PublicMessage[] {
  return pathTo(leafId).map((m) => {
    const p = toPublic(m, [m.id]);
    return {
      ...p,
      parentId: null,
      error: p.status === "declined" ? t("The AI declined to answer this message") : null,
      note: null,
      thinking: null,
      thinkingMs: null,
      instructionsChanged: false,
      // What the AI remembered about the person, or found in their documents, stays private; so
      // does how full the chat is.
      tools: p.tools.filter((t) => t.kind === "page" || t.kind === "mcp"),
      contextTokens: null,
    };
  });
}
