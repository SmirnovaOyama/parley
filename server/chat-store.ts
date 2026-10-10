// Conversation and message reads shared by the user and admin routes. A conversation is a tree:
// editing a message or regenerating a reply adds a sibling instead of rewriting history, and the
// screen shows one branch, from the first message down to the conversation's head.
import { attachmentsOf, historyAttachments, type PublicAttachment } from "./attachments.ts";
import { db } from "./db.ts";
import { instructionsNote, parseInstructions } from "./instructions.ts";
import { modelLabel } from "./providers/catalog.ts";
import type { HistoryTurn } from "./providers/types.ts";
import type { ToolUse } from "./tools.ts";

export type ConversationRow = {
  id: string;
  user_id: number;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  api_key_id: number | null;
  head_id: number | null;
  title_auto: number;
  system_prompt: string | null;
  chat_instructions: string | null;
  sealed_instructions: string | null;
  /** 1 when the chat declares Claude's web search tool; fixed when it starts. */
  web_search_tool: number;
  /** The model and thinking level this chat last ran on (with api_key_id); null on older chats. */
  model: string | null;
  effort: string | null;
  /** 1 when the chat declares Claude's code execution tool; fixed when it starts. */
  code_tool: number;
  /** The sandbox its code last ran in, which key's it is, and when it expires. */
  container_id: string | null;
  container_key_id: number | null;
  container_expires_at: string | null;
  /** The project it's in, and when it was pinned to the top of the list. */
  project_id: string | null;
  pinned_at: string | null;
  /** The app's own tools it declared when it started (JSON DeclaredTool[], see tools.ts). */
  tool_defs: string | null;
};

export type MessageRow = {
  id: number;
  conversation_id: string;
  parent_id: number | null;
  role: "user" | "assistant";
  text: string;
  content: string | null;
  provider: string | null;
  model: string | null;
  stop_reason: string | null;
  error: string | null;
  note: string | null;
  thinking: string | null;
  thinking_ms: number | null;
  /** On a user message: the chat's instructions changed here (JSON), sent right after it. */
  instructions: string | null;
  in_context: number;
  created_at: string;
  /** On a reply: the Claude model that declined before a fallback model answered. */
  declined_by: string | null;
  reviewed_at: string | null;
  reviewed_by: number | null;
  /** On a reply: JSON {searches, sources} when it searched the web. */
  web: string | null;
  /** On a user message: 1 when web search was off for it (see db.ts); a note tells the model so. */
  search_off: number;
  /** On a user message: 1 when making files (code execution) was off for it; a note says so. */
  code_off: number;
  /** On a reply: the app's tools it used (JSON ToolUse[]). */
  tools: string | null;
  /** On a reply: how much of the model's context the chat filled by its end. */
  context_tokens: number | null;
};

/** A file a reply made, as people see it: download it from /api/files/:id. */
export type PublicFile = { id: string; name: string; mime: string; size: number };

export function filesOf(messageId: number): PublicFile[] {
  return db
    .prepare("SELECT id, name, mime, size FROM message_files WHERE message_id = ? ORDER BY created_at, name")
    .all(messageId) as PublicFile[];
}

export type MessageStatus = "ok" | "truncated" | "stopped" | "declined" | "failed" | "not-sent";

export type PublicMessage = {
  id: number;
  parentId: number | null;
  role: "user" | "assistant";
  text: string;
  model: string;
  status: MessageStatus;
  error: string | null;
  note: string | null;
  /** What the model showed of its thinking, and for how long it thought. */
  thinking: string | null;
  thinkingMs: number | null;
  /** On a user message: the chat's instructions changed from here on. */
  instructionsChanged: boolean;
  /** Every version of this message (itself included), oldest first. */
  siblingIds: number[];
  /** What the reply searched the web for, and the pages its [n] markers point to. */
  searches: string[];
  sources: { url: string; title: string }[];
  /** When it cited nothing: pages its searches returned. */
  found: { url: string; title: string }[];
  /** Files the reply made (Claude's code execution). */
  files: PublicFile[];
  /** On a user message: the files attached to it. */
  attachments: PublicAttachment[];
  /** On a reply: what it did with the app's tools (saved a memory, searched knowledge, used an MCP tool). */
  tools: ToolUse[];
  /** On a reply: the chat's size in the model's context by its end, in tokens. */
  contextTokens: number | null;
  createdAt: string;
};

export function statusOf(m: Pick<MessageRow, "role" | "stop_reason" | "in_context">): MessageStatus {
  if (m.role === "user") return m.in_context ? "ok" : "not-sent";
  switch (m.stop_reason) {
    case "refusal":
    case "content_filter":
      return "declined";
    case "error":
      return "failed";
    case "aborted":
      return "stopped";
    case "max_tokens":
    case "length":
      return "truncated";
    default:
      return "ok";
  }
}

/** Replies the AI declined: refused outright, or declined by one Claude model and answered by another. */
export const DECLINED_SQL = "(m.role = 'assistant' AND (m.stop_reason IN ('refusal', 'content_filter') OR m.declined_by IS NOT NULL))";

/** The model that declined first, from a reply's Claude content blocks (a `fallback` block names it). */
export function declinedBy(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const hop = content.find((b) => b?.type === "fallback") as { from?: { model?: string } } | undefined;
  return hop?.from?.model ?? null;
}

export function siblingIds(m: Pick<MessageRow, "conversation_id" | "parent_id" | "role">): number[] {
  return (
    db
      .prepare("SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? AND role = ? ORDER BY id")
      .all(m.conversation_id, m.parent_id, m.role) as { id: number }[]
  ).map((r) => r.id);
}

export function toPublic(m: MessageRow, siblings: number[] = siblingIds(m)): PublicMessage {
  return {
    id: m.id,
    parentId: m.parent_id,
    role: m.role,
    text: m.text,
    model: modelLabel(m.provider, m.model),
    status: statusOf(m),
    error: m.error,
    note: m.note,
    thinking: m.thinking?.trim() ? m.thinking : null,
    thinkingMs: m.thinking_ms,
    instructionsChanged: m.role === "user" && !!m.instructions,
    siblingIds: siblings,
    ...webOf(m.web),
    files: m.role === "assistant" ? filesOf(m.id) : [],
    attachments: m.role === "user" ? attachmentsOf(m.id) : [],
    tools: toolsOf(m.tools),
    contextTokens: m.context_tokens,
    createdAt: m.created_at,
  };
}

function toolsOf(json: string | null): ToolUse[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function webOf(json: string | null): Pick<PublicMessage, "searches" | "sources" | "found"> {
  const none = { searches: [], sources: [], found: [] };
  if (!json) return none;
  try {
    const web = JSON.parse(json) as Partial<Pick<PublicMessage, "searches" | "sources" | "found">>;
    return { searches: web.searches ?? [], sources: web.sources ?? [], found: web.found ?? [] };
  } catch {
    return none;
  }
}

export function getConversation(id: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
}

export function getMessage(id: number): MessageRow | undefined {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
}

/** The branch ending at `leafId`, first message first. */
export function pathTo(leafId: number | null): MessageRow[] {
  if (leafId == null) return [];
  return db
    .prepare(
      `WITH RECURSIVE path(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM messages WHERE id = ?
         UNION ALL
         SELECT m.id, m.parent_id, path.depth + 1 FROM messages m JOIN path ON m.id = path.parent_id
       )
       SELECT messages.* FROM path JOIN messages ON messages.id = path.id ORDER BY path.depth DESC`,
    )
    .all(leafId) as MessageRow[];
}

/** From a message, follow the newest reply at each step down to the end of that branch. */
export function newestLeaf(fromId: number): number {
  let id = fromId;
  const child = db.prepare("SELECT id FROM messages WHERE parent_id = ? ORDER BY id DESC LIMIT 1");
  for (;;) {
    const next = child.get(id) as { id: number } | undefined;
    if (!next) return id;
    id = next.id;
  }
}

/**
 * The branch to show: the conversation's head, or (admins browsing) the newest branch running
 * through `via`, as long as `via` belongs to this conversation.
 */
export function viewPath(conv: ConversationRow, via?: number): PublicMessage[] {
  let leaf = conv.head_id;
  if (via != null) {
    const m = getMessage(via);
    if (m && m.conversation_id === conv.id) leaf = newestLeaf(m.id);
  }
  return pathTo(leaf).map((m) => toPublic(m));
}

/**
 * What gets sent to the model for the branch ending at `leafId`. Failed, declined and empty
 * stopped replies stay out, together with the message that prompted them; the last message (the
 * one being answered) is always in. Because a branch's earlier messages never change, the
 * history a reply was written against is always replayed exactly the same way.
 */
/** Follows a message sent while web search was off. Fixed text, so replays never change. */
/** Follows a message sent while making files was off. Fixed text, so replays never change. */
export const CODE_OFF_NOTE =
  "Running code and making files is turned off for this message. Don't try to run code; answer in text, with any code written out for the person to copy.";

export const SEARCH_OFF_NOTE =
  "Web search is turned off for this message. Answer from what you already know, and say so when the answer may be out of date.";

export function historyFor(leafId: number): HistoryTurn[] {
  const path = pathTo(leafId);
  const turns: HistoryTurn[] = [];
  path.forEach((m, i) => {
    const answered = path[i + 1]?.role === "assistant" && path[i + 1].in_context === 1;
    const keep = m.role === "assistant" ? m.in_context === 1 : i === path.length - 1 || answered;
    if (!keep) return;
    const attachments = m.role === "user" ? historyAttachments(m.id) : [];
    turns.push({
      role: m.role,
      text: m.text,
      content: m.content ? JSON.parse(m.content) : null,
      provider: m.provider,
      ...(attachments.length ? { attachments } : {}),
    });
    // Changed chat instructions follow the message they arrived with, as a system note: the
    // place the API allows one (after a user message, before the reply).
    if (m.role === "user" && m.instructions) {
      turns.push({ role: "system", text: instructionsNote(parseInstructions(m.instructions)), content: null, provider: null });
    }
    if (m.role === "user" && m.search_off) {
      turns.push({ role: "system", text: SEARCH_OFF_NOTE, content: null, provider: null });
    }
    if (m.role === "user" && m.code_off) {
      turns.push({ role: "system", text: CODE_OFF_NOTE, content: null, provider: null });
    }
  });
  return turns;
}

/**
 * The chat instructions in force for a message following `parentId` on its branch: the last change
 * the model actually saw (on a message that got an answer), else what the chat was sealed with.
 */
export function instructionsBefore(conv: ConversationRow, parentId: number | null): string | null {
  const path = pathTo(parentId);
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i];
    const answered = path[i + 1]?.role === "assistant" && path[i + 1].in_context === 1;
    if (m.role === "user" && m.instructions && answered) return m.instructions;
  }
  return conv.sealed_instructions;
}

/** A title from the first message: its first line, cut at a word, without a closing full stop. */
export function titleFrom(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "New chat";
  let title = line.replace(/\s+/g, " ").trim();
  if (title.length > 60) {
    const cut = title.slice(0, 60);
    const space = cut.lastIndexOf(" ");
    title = space > 30 ? cut.slice(0, space) : cut;
  }
  return title.replace(/[.。]+$/u, "").trim() || "New chat";
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
