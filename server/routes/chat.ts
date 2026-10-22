import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireUser, type AppEnv, type SessionUser } from "../auth.ts";
import {
  declinedBy,
  getConversation,
  getMessage,
  historyFor,
  instructionsBefore,
  newestLeaf,
  pathTo,
  titleFrom,
  toPublic,
  tx,
  viewPath,
  type ConversationRow,
  type MessageRow,
  type PublicMessage,
} from "../chat-store.ts";
import { allowanceOf, overLimitMessage } from "../allowance.ts";
import { searchChats } from "../chat-search.ts";
import { decryptSecret } from "../crypto.ts";
import { db, getSettings, nowIso } from "../db.ts";
import { sentences, t, tn } from "../i18n.ts";
import { availableKeys, endpointOf, keyById, keyModel, keyModelLabel, opensOf, pickerChoices, startingKey, withChoice, type KeyRow } from "../keys.ts";
import { estimateCost, hasTools, PROVIDERS } from "../providers/catalog.ts";
import { describeProviderError, getProvider, shouldUseBackup } from "../providers/index.ts";
import {
  cleanInstructions,
  getInstructions,
  instructionsJson,
  parseInstructions,
  personalOnly,
  sameInstructions,
  systemPromptFor,
} from "../instructions.ts";
import { maybeRetitle } from "../titles.ts";
import { shareOf, shareOut, shareUpTo, stopSharing } from "../shares.ts";
import { fileHeaders, keepFiles, keepWrittenFiles, storedFile } from "../files.ts";
import {
  attachTo,
  discardUpload,
  forgetProviderFiles,
  historyAttachments,
  MAX_BYTES,
  pickAttachments,
  providerFileIds,
  saveUpload,
  unreadable,
} from "../attachments.ts";
import type { ChatResult } from "../providers/types.ts";
import { canUse, getBase } from "../knowledge.ts";
import { memoryOn, memoryPrompt } from "../memory.ts";
import { chatSetting, ownProject, settingOf } from "../projects.ts";
import { answerAsk, askPerson, asksOf } from "../asks.ts";
import { chatContext, chatToolkit, codeOnSite, declaredOf, searchOnSite, toolsForNewChat, type ToolUse } from "../tools.ts";
import { searchServiceReady } from "../web-tools.ts";
import { purgeConversations } from "../retention.ts";
import { comparisonOut, comparisonRun, continuedRun, exactChoice, ownComparison, type ComparisonRow } from "../comparisons.ts";

export const chatRoutes = new Hono<AppEnv>();
chatRoutes.use("*", requireUser);

const MAX_MESSAGE_CHARS = 50_000;
const MESSAGES_PER_MINUTE = 20;
// A person chatting stays well under these. An account turned into a relay for some other app or
// for other people (a reverse proxy on the site's keys) runs into them: it sends without pause,
// and many replies at once.
const MESSAGES_PER_HOUR = 200;
const REPLIES_AT_ONCE = 3;
const UPLOADS_PER_MINUTE = 40;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// Cloudflare, and other proxies in front of the site, cut a stream that sends nothing for about
// 100 seconds, which a model thinking quietly or a long tool run can do. A comment line this often
// keeps the reply's stream open; browsers skip it.
const HEARTBEAT_MS = 20_000;

/** Replies being written right now, so a person can stop one or come back to it. */
const generating = new Map<string, { controller: AbortController; userId: number; comparisonId?: string }>();
const recentSends = new Map<number, number[]>();
const hourSends = new Map<number, number[]>();
const recentUploads = new Map<number, number[]>();

/** The provider couldn't find a file id it was given: the file was deleted from that account. */
function lostFile(err: unknown): boolean {
  const { status, message } = err as { status?: number; message?: string };
  return (status === 400 || status === 404) && /file/i.test(message ?? "") && /not found|does not exist|no such/i.test(message ?? "");
}

function ownConversation(id: string, userId: number) {
  const conv = getConversation(id);
  return conv && conv.user_id === userId && !conv.deleted_at ? conv : undefined;
}

function rateLimited(userId: number, recent = recentSends, limit = MESSAGES_PER_MINUTE, windowMs = MINUTE_MS): boolean {
  const now = Date.now();
  const times = (recent.get(userId) ?? []).filter((t) => now - t < windowMs);
  times.push(now);
  recent.set(userId, times);
  return times.length > limit;
}

/** How many replies are being written for this person right now, across all their chats. */
function repliesUnderway(userId: number): number {
  let n = 0;
  for (const job of generating.values()) if (job.userId === userId) n++;
  return n;
}

/** Checks temporary capacity without spending it, so a scheduled occurrence can wait its turn. */
export function chatCapacityAvailable(userId: number): boolean {
  const now = Date.now();
  return repliesUnderway(userId) < REPLIES_AT_ONCE &&
    (recentSends.get(userId) ?? []).filter((at) => now - at < MINUTE_MS).length < MESSAGES_PER_MINUTE &&
    (hourSends.get(userId) ?? []).filter((at) => now - at < HOUR_MS).length < MESSAGES_PER_HOUR;
}

/** The models this person can pick from, and which one new chats start with. */
chatRoutes.get("/models", (c) => {
  const userId = c.var.user!.id;
  const keys = availableKeys(userId);
  const start = startingKey(userId, keys);
  return c.json({
    choices: pickerChoices(keys),
    start: start ? { keyId: start.id, model: start.model, effort: start.effort } : null,
  });
});

const comparisonActivity = (conversationId: string, comparisonId: string) => {
  const active = generating.get(conversationId)?.comparisonId === comparisonId;
  return { generating: active, asks: active ? asksOf(conversationId) : [] };
};

chatRoutes.get("/comparisons", (c) => {
  const rows = db.prepare("SELECT * FROM comparisons WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500").all(c.var.user!.id) as ComparisonRow[];
  return c.json({ comparisons: rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at })) });
});

chatRoutes.get("/comparisons/:id", (c) => {
  const row = ownComparison(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This comparison doesn't exist") }, 404);
  return c.json(comparisonOut(row, comparisonActivity));
});

/** Creates every column before any provider is called, so failures and leaving the page are recoverable. */
chatRoutes.post("/comparisons", async (c) => {
  const userId = c.var.user!.id;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray(body.choices) || body.choices.length < 2 || body.choices.length > 3) {
    return c.json({ error: t("Pick two or three models to compare") }, 400);
  }
  const keys: KeyRow[] = [];
  for (const choice of body.choices) {
    const key = exactChoice(userId, choice);
    if (!key) return c.json({ error: t("One of the selected models or thinking levels is no longer available") }, 400);
    if (keys.some((k) => k.id === key.id && k.model === key.model)) return c.json({ error: t("Pick a different model for each answer") }, 400);
    keys.push(key);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length > MAX_MESSAGE_CHARS) return c.json({ error: t("That message is too long") }, 400);
  const files = pickAttachments(userId, null, body.attachments);
  if (!Array.isArray(files)) return c.json(files, 400);
  if (!text && !files.length) return c.json({ error: t("Write a message first") }, 400);
  const codeTool = codeOnSite();
  for (const key of keys) {
    const error = unreadable(files, key, keyModelLabel(key, key.model), codeTool);
    if (error) return c.json({ error }, 400);
  }
  const overLimit = overLimitMessage(allowanceOf(userId));
  if (overLimit) return c.json({ error: overLimit }, 429);
  const instructions = body.instructions === undefined ? getInstructions(userId) : cleanInstructions(body.instructions);
  if (!instructions) return c.json({ error: t("Keep each instruction under 1500 characters") }, 400);
  const project = body.projectId ? ownProject(body.projectId, userId) : undefined;
  if (body.projectId && !project) return c.json({ error: t("That project doesn't exist") }, 404);
  if (body.knowledgeIds !== undefined && !Array.isArray(body.knowledgeIds)) return c.json({ error: t("Pick the knowledge bases for this chat") }, 400);
  const knowledgeIds = [...new Set<string>((body.knowledgeIds ?? []).map(String))];
  if (knowledgeIds.some((id) => !canUse(getBase(id), userId))) return c.json({ error: t("One of those knowledge bases isn't yours to use") }, 400);

  // All columns copy one starting context, just as a normal new chat does. A model's own search
  // and code switches still apply; tools and knowledge have their usual permission checks.
  const id = randomUUID();
  const title = titleFrom(text || files.map((f) => f.name).join(", "));
  const now = nowIso();
  const searchTool = searchOnSite();
  const toolDefs = toolsForNewChat(userId);
  const memory = memoryOn(userId) ? memoryPrompt(userId) : null;
  tx(() => {
    db.prepare("INSERT INTO comparisons (id, user_id, title, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, title, text, now, now);
    let firstPromptId: number | null = null;
    let system = "";
    let sealed = "";
    for (const [position, key] of keys.entries()) {
      const conversationId = randomUUID();
      db.prepare(
        `INSERT INTO conversations (id, user_id, title, api_key_id, model, effort, system_prompt, chat_instructions,
           sealed_instructions, web_search_tool, code_tool, project_id, tool_defs, title_auto, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, NULL, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(conversationId, userId, title, key.id, key.model, key.effort, instructionsJson(instructions),
        searchTool ? 1 : 0, codeTool ? 1 : 0, project?.id ?? null, toolDefs.length ? JSON.stringify(toolDefs) : null, now, now);
      const link = db.prepare("INSERT INTO conversation_knowledge (conversation_id, kb_id) VALUES (?, ?)");
      for (const kb of knowledgeIds) link.run(conversationId, kb);
      if (position === 0) {
        const setting = chatSetting(instructions, userId, conversationId, project?.id ?? null);
        sealed = instructionsJson(setting);
        system = systemPromptFor(setting, memory);
      }
      db.prepare("UPDATE conversations SET system_prompt = ?, sealed_instructions = ? WHERE id = ?").run(system, sealed, conversationId);
      const searchOff = searchTool && !key.web_search && (hasTools(key.provider) || searchServiceReady());
      const codeOff = codeTool && hasTools(key.provider) && !key.code_execution;
      const promptId = Number(db.prepare(
        "INSERT INTO messages (conversation_id, role, text, search_off, code_off, created_at) VALUES (?, 'user', ?, ?, ?, ?)",
      ).run(conversationId, text, searchOff ? 1 : 0, codeOff ? 1 : 0, now).lastInsertRowid);
      // The first message takes ownership of the pending uploads; later columns reference the
      // same bytes with their own attachment rows, as editing a message already does.
      attachTo(promptId, firstPromptId == null ? files : files.map((file) => ({ ...file, message_id: firstPromptId })));
      firstPromptId ??= promptId;
      db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(promptId, conversationId);
      db.prepare(
        `INSERT INTO comparison_runs (comparison_id, position, conversation_id, prompt_message_id, key_id, model, effort, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, position, conversationId, promptId, key.id, key.model, key.effort, keyModelLabel(key, key.model));
    }
  });
  return c.json(comparisonOut(ownComparison(id, userId)!, comparisonActivity));
});

chatRoutes.get("/conversations", (c) => {
  const rows = db
    .prepare(
      `SELECT cv.id, cv.title, cv.updated_at, cv.project_id, cv.pinned_at,
         EXISTS (SELECT 1 FROM shares s WHERE s.conversation_id = cv.id) AS shared
       FROM conversations cv WHERE cv.user_id = ? AND cv.deleted_at IS NULL
       ORDER BY cv.pinned_at IS NULL, cv.pinned_at DESC, cv.updated_at DESC LIMIT 500`,
    )
    .all(c.var.user!.id) as { id: string; title: string; updated_at: string; project_id: string | null; pinned_at: string | null; shared: number }[];
  return c.json({
    // generating: a reply is being written for it right now (the chat list shows a spinner).
    conversations: rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      projectId: r.project_id,
      pinnedAt: r.pinned_at,
      shared: !!r.shared,
      generating: generating.has(r.id),
    })),
  });
});

/** Searches the person's own chats by title and message (only theirs, never one they deleted). */
chatRoutes.get("/conversations/search", (c) => {
  return c.json({ results: searchChats(c.var.user!.id, c.req.query("q") ?? "") });
});

chatRoutes.get("/conversations/:id", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  return c.json({
    conversation: {
      id: conv.id,
      title: conv.title,
      updatedAt: conv.updated_at,
      keyId: conv.api_key_id,
      model: conv.model,
      effort: conv.effort,
      comparisonId: comparisonRun(conv.id)?.comparison_id ?? null,
      instructions: personalOnly(parseInstructions(conv.chat_instructions)),
      project: conv.project_id ? projectOut(conv.project_id, conv.user_id) : null,
      knowledgeIds: (db.prepare("SELECT kb_id FROM conversation_knowledge WHERE conversation_id = ?").all(conv.id) as { kb_id: string }[]).map((r) => r.kb_id),
      pinned: !!conv.pinned_at,
    },
    messages: viewPath(conv),
    generating: generating.has(conv.id),
    // Questions the reply being written is waiting on, for someone who comes back to it.
    asks: generating.has(conv.id) ? asksOf(conv.id) : [],
    share: shareInfo(conv),
    sharing: getSettings().sharing,
  });
});

function projectOut(id: string, userId: number) {
  const p = ownProject(id, userId);
  return p ? { id: p.id, name: p.name } : null;
}

function shareInfo(conv: ConversationRow) {
  const share = shareOf(conv.id);
  return share ? shareOut(share) : null;
}

/** Makes a read-only link to the chat as it is now, or moves the existing link up to now. */
chatRoutes.post("/conversations/:id/share", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  if (getSettings().sharing === "off") return c.json({ error: t("An admin has turned sharing off") }, 403);
  if (generating.has(conv.id)) return c.json({ error: t("Wait for the reply to finish first") }, 409);
  if (conv.head_id == null) return c.json({ error: t("There's nothing to share yet") }, 400);
  return c.json({ share: shareOut(shareUpTo(conv)) });
});

chatRoutes.delete("/conversations/:id/share", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  stopSharing(conv.id);
  return c.json({ share: null });
});

/**
 * The chat as a Markdown file: the branch on screen, each message under who wrote it, cited
 * sources as links. Thinking stays out. The file is named after the chat (non-ASCII titles kept,
 * through the UTF-8 form of Content-Disposition).
 */
chatRoutes.get("/conversations/:id/export", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  const parts = [`# ${conv.title}`];
  for (const m of viewPath(conv)) {
    if (m.role === "user") {
      const files = m.attachments.length ? t("_Attached {map}_", { map: m.attachments.map((a) => a.name).join(", ") }) : "";
      parts.push(`**${t("You")}**\n\n${[files, m.text].filter(Boolean).join("\n\n")}`);
      continue;
    }
    let body = m.text.trim();
    if (m.status === "declined") body = t("_The AI declined to answer this message_");
    else if (m.status === "failed") body = t("_No reply came back_");
    else if (!body) continue;
    if (m.sources.length) body += `\n\n${t("Sources:")}\n${m.sources.map((src, i) => `${i + 1}. [${src.title || src.url}](${src.url})`).join("\n")}`;
    parts.push(`**${m.model || t("AI")}**\n\n${body}`);
  }
  const name = conv.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || t("Chat");
  const ascii = name.replace(/[^\x20-\x7e]+/g, "").trim() || "chat";
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${ascii.replace(/"/g, "")}.md"; filename*=UTF-8''${encodeURIComponent(name)}.md`);
  c.header("Cache-Control", "private, no-store");
  return c.body(`${parts.join("\n\n---\n\n")}\n`);
});

/**
 * A file a reply made or a person attached: for the chat's owner (or whoever uploaded it, before
 * it's sent), and admins (who can read every chat).
 */
chatRoutes.get("/files/:id", (c) => {
  const file = storedFile(c.req.param("id"));
  const user = c.var.user!;
  if (!file || (file.owner_id !== user.id && user.role !== "admin") || !existsSync(file.path)) {
    return c.json({ error: t("This file isn't here any more") }, 404);
  }
  for (const [name, value] of Object.entries(fileHeaders(file, c.req.query("inline") === "1"))) c.header(name, value);
  return c.body(readFileSync(file.path));
});

/**
 * Adds a file to the message being written: the raw bytes as the body, the name in X-File-Name
 * (URI-encoded). It waits, unsent, until a message takes it. A PUT with its own header can't be
 * sent from another site without the browser asking first, which this API never allows.
 */
chatRoutes.put(
  "/uploads",
  bodyLimit({ maxSize: MAX_BYTES, onError: (c) => c.json({ error: t("Files can be up to {MAX_BYTES} MB", { MAX_BYTES: MAX_BYTES / (1024 * 1024) }) }, 413) }),
  async (c) => {
    const user = c.var.user!;
    if (rateLimited(user.id, recentUploads, UPLOADS_PER_MINUTE)) {
      return c.json({ error: t("You're adding files quickly. Wait a moment and try again") }, 429);
    }
    let name = "file";
    try {
      name = decodeURIComponent(c.req.header("x-file-name") ?? "") || name;
    } catch {
      // Keep the plain name.
    }
    const saved = saveUpload(user.id, name, Buffer.from(await c.req.arrayBuffer()));
    if ("error" in saved) return c.json(saved, 400);
    return c.json({ attachment: saved });
  },
);

/** Removes a file that was added but not sent. */
chatRoutes.delete("/uploads/:id", (c) => {
  discardUpload(c.var.user!.id, c.req.param("id"));
  return c.json({ ok: true });
});

/** This chat's own instructions. A change applies from the next message, as a system note. */
chatRoutes.put("/conversations/:id/instructions", async (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  const cleaned = cleanInstructions(await c.req.json().catch(() => ({})));
  if (!cleaned) return c.json({ error: t("Keep each instruction under 1500 characters") }, 400);
  db.prepare("UPDATE conversations SET chat_instructions = ? WHERE id = ?").run(instructionsJson(cleaned), conv.id);
  return c.json(cleaned);
});

/** Shows another version of a message: the chat follows that version's newest branch. */
chatRoutes.post("/conversations/:id/branch", async (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  if (generating.has(conv.id)) return c.json({ error: t("Wait for the reply to finish first") }, 409);
  const body = await c.req.json().catch(() => ({}));
  const message = getMessage(Number(body.messageId));
  if (!message || message.conversation_id !== conv.id) return c.json({ error: t("That message isn't in this chat") }, 400);
  const head = newestLeaf(message.id);
  db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(head, conv.id);
  return c.json({ messages: viewPath({ ...conv, head_id: head }) });
});

/** Renames a chat, moves it into a project or out of one, or pins it to the top of the list. */
chatRoutes.patch("/conversations/:id", async (c) => {
  const user = c.var.user!;
  const conv = ownConversation(c.req.param("id"), user.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (body.title !== undefined) {
    const title = String(body.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) return c.json({ error: t("Give the chat a name") }, 400);
    // A name someone chose is never rewritten by the automatic titles.
    db.prepare("UPDATE conversations SET title = ?, title_auto = 0 WHERE id = ?").run(title, conv.id);
  }
  if (body.projectId !== undefined) {
    const project = body.projectId === null ? null : ownProject(body.projectId, user.id);
    if (body.projectId !== null && !project) return c.json({ error: t("That project doesn't exist") }, 404);
    db.prepare("UPDATE conversations SET project_id = ? WHERE id = ?").run(project?.id ?? null, conv.id);
  }
  if (body.pinned !== undefined) {
    db.prepare("UPDATE conversations SET pinned_at = ? WHERE id = ?").run(body.pinned ? nowIso() : null, conv.id);
  }
  return c.json({ ok: true });
});

/** The knowledge bases this chat searches, besides its project's. A change reaches the model with the next message. */
chatRoutes.put("/conversations/:id/knowledge", async (c) => {
  const user = c.var.user!;
  const conv = ownConversation(c.req.param("id"), user.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.knowledgeIds) ? [...new Set((body.knowledgeIds as unknown[]).map(String))] : null;
  if (!ids) return c.json({ error: t("Pick the knowledge bases for this chat") }, 400);
  if (ids.some((id) => !canUse(getBase(id), user.id))) return c.json({ error: t("One of those knowledge bases isn't yours to use") }, 400);
  tx(() => {
    db.prepare("DELETE FROM conversation_knowledge WHERE conversation_id = ?").run(conv.id);
    const add = db.prepare("INSERT INTO conversation_knowledge (conversation_id, kb_id) VALUES (?, ?)");
    for (const id of ids) add.run(conv.id, id);
  });
  return c.json({ knowledgeIds: ids });
});

// Deleting hides the chat from its owner; admins keep it for their records (the prompt says so),
// for as long as the site's retention rules say.
chatRoutes.delete("/conversations/:id", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  generating.get(conv.id)?.controller.abort();
  db.prepare("UPDATE conversations SET deleted_at = ? WHERE id = ?").run(nowIso(), conv.id);
  // A deleted chat's link stops working with it.
  stopSharing(conv.id);
  // Where the site keeps no deleted chats, it goes for good straight away.
  if (getSettings().retainDeletedDays === 0) purgeConversations([conv.id]);
  return c.json({ ok: true });
});

chatRoutes.post("/conversations/:id/stop", (c) => {
  const job = generating.get(c.req.param("id"));
  if (job && job.userId === c.var.user!.id) job.controller.abort();
  return c.json({ ok: true });
});

/** The person's answer to a question the reply is waiting on (asks.ts): allow: true lets the tool run. */
chatRoutes.post("/conversations/:id/asks/:askId", async (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: t("This chat doesn't exist") }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.allow !== "boolean") return c.json({ error: t("Say whether to allow it") }, 400);
  if (!answerAsk(conv.id, c.req.param("askId"), body.allow)) return c.json({ error: t("That isn't waiting for an answer any more") }, 409);
  return c.json({ ok: true });
});

/** A request that cannot start, before a provider is called. */
export class ChatStartError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ChatStartError";
    this.status = status;
  }
}

type ChatSender = (event: string, data: unknown) => Promise<void>;
type Offered = { functions: import("../providers/types.ts").ToolSpec[]; runTool: (call: import("../providers/types.ts").ToolCall) => Promise<import("../providers/types.ts").ToolOutcome> };
/**
 * A turn of a Cowork job (cowork.ts), which runs unattended in the job's own chat: a note for the
 * model on how to work, the job's own tools and step record around the chat's, the person's OK
 * held for when they're back, and what the turn cost.
 */
export type JobTurn = {
  system: string;
  tools: (offered: Offered) => Offered;
  ask: (conversationId: string, question: Omit<import("../asks.ts").Ask, "id">, signal: AbortSignal) => Promise<import("../asks.ts").Answer>;
  spent: (cost: number) => void;
};
export type PreparedChat = {
  conversationId: string;
  cancel: () => void;
  run: (send?: ChatSender) => Promise<PublicMessage>;
};

/**
 * Prepares a reply and reserves its slot, for a browser or background caller. Three ways in:
 * - `text`: a new message at the end of the branch on screen (or the first of a new chat);
 * - `text` + `parentId`: an edit, a new version of the message that followed `parentId`
 *   (null for the first message), so the old version and its replies stay as a branch;
 * - `regenerate`: a new version of the reply to that user message, with no new message.
 * A new message or an edit can carry `attachments`: ids of files uploaded for it, or (editing)
 * of files on a message in this chat, which the new version keeps.
 */
export async function prepareChat(
  user: SessionUser,
  body: Record<string, unknown>,
  options: { unattended?: boolean; title?: string; job?: JobTurn } = {},
): Promise<PreparedChat> {
  // These options belong to trusted server callers, never to the HTTP body.
  const job = options.job;
  const unattended = options.unattended === true || !!job;
  if (unattended) {
    const account = db.prepare("SELECT id, email, role, disabled FROM users WHERE id = ?").get(user.id) as (SessionUser & { disabled: number }) | undefined;
    if (!account || account.disabled) throw new ChatStartError(403, t("This account is turned off. Ask an admin"));
    user = { id: account.id, email: account.email, role: account.role };
  }
  const regenerate = body.regenerate != null ? Number(body.regenerate) : null;
  const editing = regenerate == null && body.parentId !== undefined;
  const text = String(body.text ?? "").trim();
  if (text.length > MAX_MESSAGE_CHARS) throw new ChatStartError(400, t("That message is too long"));

  // A job carries on in its own chat; scheduled tasks start a new one each time.
  if (unattended && ((!job && (body.conversationId != null || body.regenerate != null)) || body.parentId !== undefined || body.comparisonId !== undefined)) {
    throw new ChatStartError(400, t("Scheduled tasks start a new chat each time"));
  }

  let conversationId = body.conversationId ? String(body.conversationId) : null;
  const existing = conversationId ? ownConversation(conversationId, user.id) : undefined;
  if (conversationId && !existing) throw new ChatStartError(404, t("This chat doesn't exist"));
  const files = regenerate == null ? pickAttachments(user.id, existing?.id ?? null, body.attachments) : [];
  if (!Array.isArray(files)) throw new ChatStartError(400, files.error);
  if (regenerate == null && !text && !files.length) throw new ChatStartError(400, t("Write a message first"));
  if ((editing || regenerate != null) && !existing) throw new ChatStartError(404, t("This chat doesn't exist"));
  if (conversationId && generating.has(conversationId)) {
    throw new ChatStartError(409, t("A reply is still being written in this chat"));
  }

  // Where the new message (or regenerated reply) attaches in the tree.
  let parentId: number | null = existing?.head_id ?? null;
  if (regenerate != null) {
    const prompt = getMessage(regenerate);
    if (!prompt || prompt.conversation_id !== conversationId || prompt.role !== "user") {
      throw new ChatStartError(400, t("That message isn't in this chat"));
    }
    parentId = prompt.id;
  } else if (editing) {
    parentId = body.parentId === null ? null : Number(body.parentId);
    const parent = parentId == null ? null : getMessage(parentId);
    if (parentId != null && (!parent || parent.conversation_id !== conversationId || parent.role !== "assistant")) {
      throw new ChatStartError(400, t("That message isn't in this chat"));
    }
  }

  // The key, model and thinking level asked for, else what this chat used last, else the person's
  // starting key as it starts. A model or level the key doesn't offer falls back to its own.
  const available = availableKeys(user.id);
  const requested = body.keyId != null ? Number(body.keyId) : (existing?.api_key_id ?? null);
  const picked = available.find((k) => k.id === requested) ?? startingKey(user.id, available);
  if (!picked) throw new ChatStartError(409, t("No AI model is set up yet. Ask an admin to add one"));
  const sameKey = existing?.api_key_id === picked.id;
  let key = withChoice(
    picked,
    body.model != null ? String(body.model) : sameKey ? existing?.model : null,
    body.effort != null ? String(body.effort) : sameKey ? existing?.effort : null,
  );
  const comparisonId = typeof body.comparisonId === "string" ? body.comparisonId : undefined;
  if (body.comparisonId !== undefined) {
    if (!comparisonId || !ownComparison(comparisonId, user.id)) throw new ChatStartError(404, t("This comparison doesn't exist"));
    const run = existing && comparisonRun(existing.id);
    if (!run || run.comparison_id !== comparisonId || regenerate !== run.prompt_message_id ||
        body.keyId !== run.key_id || body.model !== run.model || body.effort !== run.effort) {
      throw new ChatStartError(400, t("This answer doesn't match the comparison"));
    }
    if (continuedRun(run, existing!)) throw new ChatStartError(409, t("This chat has continued since the comparison"));
    const exact = exactChoice(user.id, { keyId: run.key_id, model: run.model, effort: run.effort });
    if (!exact) throw new ChatStartError(409, t("This model is no longer available for the comparison"));
    key = exact;
  }
  if (unattended) {
    const exact = exactChoice(user.id, body);
    if (!exact) throw new ChatStartError(409, t("The selected model or thinking level is no longer available"));
    key = exact;
  }
  const codeTool = existing ? !!existing.code_tool : codeOnSite();
  // The files the model has to open for this reply: the new message's, or the regenerated one's.
  const messageFiles = regenerate == null ? files : historyAttachments(regenerate);
  const cantRead = unreadable(messageFiles, key, keyModelLabel(key, key.model), codeTool);
  if (cantRead) throw new ChatStartError(400, cantRead);
  const overLimit = overLimitMessage(allowanceOf(user.id));
  if (overLimit) throw new ChatStartError(429, overLimit);
  if (repliesUnderway(user.id) >= REPLIES_AT_ONCE) {
    throw new ChatStartError(429, t("{REPLIES_AT_ONCE} replies are being written for you already. Wait for one to finish", { REPLIES_AT_ONCE }));
  }
  if (rateLimited(user.id)) throw new ChatStartError(429, t("You're sending messages quickly. Wait a moment and try again"));
  if (rateLimited(user.id, hourSends, MESSAGES_PER_HOUR, HOUR_MS)) {
    throw new ChatStartError(429, t("You've sent {MESSAGES_PER_HOUR} messages in the last hour. Try again a little later", { MESSAGES_PER_HOUR }));
  }

  // A new chat starts with the instructions set on its page, or the person's defaults in Settings, in
  // the project it was started from, with the knowledge bases picked for it.
  let startInstructions = getInstructions(user.id);
  if (!existing && body.instructions !== undefined) {
    const cleaned = cleanInstructions(body.instructions);
    if (!cleaned) throw new ChatStartError(400, t("Keep each instruction under 1500 characters"));
    startInstructions = cleaned;
  }
  const startProject = !existing && body.projectId ? ownProject(body.projectId, user.id) : undefined;
  if (!existing && body.projectId && !startProject) throw new ChatStartError(404, t("That project doesn't exist"));
  const startKnowledge = !existing && Array.isArray(body.knowledgeIds) ? [...new Set((body.knowledgeIds as unknown[]).map(String))] : [];
  if (startKnowledge.some((id) => !canUse(getBase(id), user.id))) throw new ChatStartError(400, t("One of those knowledge bases isn't yours to use"));

  const now = nowIso();
  const created = !conversationId;
  const title = created ? options.title?.trim() || titleFrom(text || files.map((f) => f.name).join(", ")) : existing!.title;
  // Whether this chat declares web search is settled when it starts: yes while any Claude or OpenAI
  // key has search on. It never changes after (see db.ts); each key's switch then decides. Claude
  // needs this, because it ties its reasoning to the tools a chat declares. GPT's history goes
  // back as plain text, so it could take the tool or leave it on any message, but it follows the
  // same rule, so a chat that moves between the two searches, or doesn't, the same way throughout.
  const searchTool = existing ? !!existing.web_search_tool : searchOnSite();
  // A new message in such a chat whose key has search off says so to the model (see db.ts).
  // (Models without search of their own search through the site's search service, when it's set up.)
  const searchOff = searchTool && !key.web_search && (hasTools(key.provider) || searchServiceReady());
  // Making files works the same way: declared from the start or never, then the key decides.
  const codeOff = codeTool && hasTools(key.provider) && !key.code_execution;
  // A chat keeps the system prompt it started with, so editing the site's or the chat's
  // instructions never rewrites a chat in progress. Chats from before prompts were kept started
  // with the site's instructions alone, so that's what they keep.
  let system = existing ? (existing.system_prompt ?? getSettings().systemPrompt) : "";
  // The chat's setting (its instructions, project, knowledge) changed since the model last saw it on
  // this branch: the new message carries it, and it goes to the model as a system note right after.
  const before = existing ? parseInstructions(instructionsBefore(existing, parentId)) : null;
  const current = existing ? settingOf(existing, personalOnly(parseInstructions(existing.chat_instructions)), before!) : null;
  const changedInstructions = existing && regenerate == null && !sameInstructions(current!, before!) ? instructionsJson(current!) : null;
  // The app's own tools a new chat declares: settled now, for good (see db.ts).
  const offeredTools = existing ? declaredOf(existing.tool_defs) : toolsForNewChat(user.id);
  // Scheduled replies can search the person's documents, but cannot change memory or use MCP.
  // A job uses all but memory: what needs the person's OK waits for them.
  const toolDefs = job ? offeredTools.filter((tool) => tool.name !== "memory")
    : unattended ? offeredTools.filter((tool) => tool.name === "search_knowledge" && !tool.mcp) : offeredTools;
  const userMessageId = tx(() => {
    if (!conversationId) {
      conversationId = randomUUID();
      db.prepare(
        `INSERT INTO conversations (id, user_id, title, api_key_id, model, effort, system_prompt, chat_instructions,
           sealed_instructions, web_search_tool, code_tool, project_id, tool_defs, title_auto, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        conversationId, user.id, title, key.id, key.model, key.effort, instructionsJson(startInstructions),
        searchTool ? 1 : 0, codeTool ? 1 : 0, startProject?.id ?? null, toolDefs.length ? JSON.stringify(toolDefs) : null, unattended ? 0 : 1, now, now,
      );
      const link = db.prepare("INSERT INTO conversation_knowledge (conversation_id, kb_id) VALUES (?, ?)");
      for (const id of startKnowledge) link.run(conversationId, id);
      // Sealed with what it starts in: instructions, project, knowledge, and memory while it's on.
      const setting = chatSetting(startInstructions, user.id, conversationId, startProject?.id ?? null);
      system = systemPromptFor(setting, memoryOn(user.id) ? memoryPrompt(user.id) : null);
      db.prepare("UPDATE conversations SET system_prompt = ?, sealed_instructions = ? WHERE id = ?").run(system, instructionsJson(setting), conversationId);
    } else {
      db.prepare(
        "UPDATE conversations SET updated_at = ?, api_key_id = ?, model = ?, effort = ?, system_prompt = ? WHERE id = ?",
      ).run(now, key.id, key.model, key.effort, system, conversationId);
    }
    if (regenerate != null) {
      db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(regenerate, conversationId);
      return regenerate;
    }
    const id = Number(
      db
        .prepare(
          `INSERT INTO messages (conversation_id, parent_id, role, text, instructions, search_off, code_off, created_at)
           VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`,
        )
        .run(conversationId, parentId, text, changedInstructions, searchOff ? 1 : 0, codeOff ? 1 : 0, now).lastInsertRowid,
    );
    attachTo(id, files);
    db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(id, conversationId);
    return id;
  });
  const convId = conversationId!;

  const controller = new AbortController();
  generating.set(convId, { controller, userId: user.id, comparisonId });

  const release = () => {
    // A later reply may already own the conversation while this one finishes naming it.
    if (generating.get(convId)?.controller === controller) generating.delete(convId);
  };
  const execute = async (send: ChatSender): Promise<PublicMessage> => {
    await send("meta", {
      conversationId: convId,
      title,
      created,
      userMessageId,
      keyId: key.id,
      model: keyModelLabel(key, key.model),
      modelId: key.model,
      effort: key.effort,
    });

    let partial = "";
    let thought = "";
    // Thinking time runs from when the model starts thinking to the first word of the answer
    // (Claude's summary text can arrive in a burst just before the answer, so not from that).
    let thinkingStarted = 0;
    let thinkingMs: number | null = null;
    const notes: string[] = [];
    const history = historyFor(userMessageId);
    const { showThinking } = getSettings();
    // Search is allowed as the message was sent: a regenerated reply keeps its message's setting,
    // because the note that goes with it can't change afterwards.
    const searchAllowed = !getMessage(userMessageId)?.search_off;
    const codeAllowed = !getMessage(userMessageId)?.code_off;
    // The sandbox this chat's code ran in, when it's this key's and won't expire mid-reply.
    const chatRow = getConversation(convId);
    const containerFor = (k: KeyRow) =>
      chatRow?.container_id && chatRow.container_key_id === k.id &&
      (!chatRow.container_expires_at || Date.parse(chatRow.container_expires_at) > Date.now() + 5 * 60_000)
        ? chatRow.container_id
        : null;

    // The app's own tools: the chat's, and web search where the model has none of its own. Some
    // calls wait for the person's OK, asked on a line in the reply (asks.ts).
    const kit = chatToolkit({
      userId: user.id,
      conversationId: convId,
      declared: toolDefs,
      context: chatContext(pathTo(userMessageId)),
      ask: (question) => job ? job.ask(convId, question, controller.signal)
        : unattended ? Promise.resolve("deny") : askPerson(convId, question, controller.signal, (asks) => void send("asks", { asks })),
      signal: controller.signal,
      onStatus: (status, detail) => void send("status", { status, detail }),
    });
    const webToolsFor = (k: KeyRow) => searchTool && searchAllowed && !hasTools(k.provider) && !!k.web_search && searchServiceReady();
    // Models that can't run code write files out as text instead, while their key's "Make files" is on.
    const fileToolFor = (k: KeyRow) => !hasTools(k.provider) && !!k.code_execution;

    // Claude reads attached files from its own account, and OpenAI's sandbox takes them from its
    // account when the reply can run code: any not uploaded there yet go first. If the account lost
    // one (deleted there), ordinary chats upload again and try once more. Comparison retries stay
    // explicit, since repeating a reply could run a memory or MCP action a second time.
    const attempt = async (k: KeyRow): Promise<ChatResult> => {
      const apiKey = decryptSecret(k.encrypted_key);
      const withFiles =
        history.some((t) => t.attachments?.length) &&
        (k.provider === "anthropic" || (k.provider === "openai" && codeTool && codeAllowed));
      const run = async () => {
        const fileIds = withFiles
          ? await providerFileIds(k.provider, apiKey, history, () => void send("status", { status: "uploading" }))
          : undefined;
        return ask(k, apiKey, fileIds);
      };
      try {
        return await run();
      } catch (err) {
        if (unattended || comparisonId || !withFiles || partial || controller.signal.aborted || !lostFile(err)) throw err;
        forgetProviderFiles(apiKey, history);
        return await run();
      }
    };
    const ask = (k: KeyRow, apiKey: string, fileIds: Map<string, string> | undefined) =>
      getProvider(k.provider).chat({
        apiKey,
        exactModel: unattended || !!comparisonId,
        baseUrl: endpointOf(k)?.baseUrl,
        reads: opensOf(k),
        cacheKey: convId,
        fileIds,
        model: k.model,
        effort: k.effort,
        system: job ? [system, job.system].filter(Boolean).join("\n\n") : system,
        history,
        signal: controller.signal,
        showThinking,
        searchTool,
        searchAllowed,
        codeTool,
        codeAllowed,
        container: containerFor(k),
        ...(job ? job.tools(kit.offer(webToolsFor(k), fileToolFor(k))) : kit.offer(webToolsFor(k), fileToolFor(k))),
        onText: (delta) => {
          if (thinkingStarted && thinkingMs == null) thinkingMs = Date.now() - thinkingStarted;
          partial += delta;
          void send("delta", { text: delta });
        },
        onThinking: (delta) => {
          if (!thinkingStarted) thinkingStarted = Date.now();
          thought += delta;
          void send("thinking", { text: delta });
        },
        onStatus: (status, detail) => {
          if (status === "thinking" && !thinkingStarted) thinkingStarted = Date.now();
          // The model's own web search brings in pages too.
          if (status === "searching") kit.tookIn();
          void send("status", { status, ...(detail ? { detail } : {}) });
        },
        onNotice: (message) => {
          notes.push(message);
          void send("notice", { message });
        },
      });

    let used = key;
    let result: ChatResult | null = null;
    let failure: string | null = null;
    try {
      try {
        if (!controller.signal.aborted) result = await attempt(key);
      } catch (err) {
        // Before any text has arrived, a key or provider failure moves to the backup key once.
        const backup = keyById(key.fallback_key_id);
        if (unattended || comparisonId || controller.signal.aborted || partial || !backup || backup.id === key.id || !shouldUseBackup(err)) throw err;
        // A backup that can't open this message's files would answer without them.
        if (unreadable(messageFiles, backup, "", codeTool)) throw err;
        console.error(`[chat] ${key.provider}/${key.model} failed, trying backup "${backup.label}":`, err);
        used = backup;
        const note = t("Answered with {keyModelLabel} because {keyModelLabel2} was unavailable", {
          keyModelLabel: keyModelLabel(backup, backup.model),
          keyModelLabel2: keyModelLabel(key, key.model),
        });
        notes.push(note);
        void send("notice", { message: note });
        result = await attempt(backup);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        // Admins also see which key failed; everyone else never sees key names.
        failure = describeProviderError(err) + (user.role === "admin" ? ` ${t("(key “{label}”)", { label: used.label })}` : "");
        console.error(`[chat] ${used.provider}/${used.model} failed:`, err);
      }
    }

    if (thinkingStarted && thinkingMs == null) thinkingMs = Date.now() - thinkingStarted;
    // Searches through the site's service show under the reply like a model's own.
    if (result && !result.searches.length && kit.searches.length) {
      result.searches = kit.searches;
      if (!result.sources.length) result.found = kit.found;
    }
    if (result?.container) {
      db.prepare("UPDATE conversations SET container_id = ?, container_key_id = ?, container_expires_at = ? WHERE id = ?").run(
        result.container.id,
        used.id,
        result.container.expiresAt,
        convId,
      );
    }
    const saved = saveOutcome({
      convId,
      userId: user.id,
      userMessageId,
      key: used,
      partial,
      result,
      stopped: controller.signal.aborted,
      failure,
      note: sentences(notes) || null,
      thinking: thought.trim() || null,
      thinkingMs: thought.trim() ? thinkingMs : null,
      tools: kit.uses,
      pageUrls: kit.pageUrls,
    });
    if (job && result) job.spent(estimateCost(keyModel(used, used.model), result.usage, used.provider));
    if (comparisonId) {
      db.prepare("UPDATE comparison_runs SET answer_message_id = ? WHERE comparison_id = ? AND conversation_id = ?").run(saved.id, comparisonId, convId);
      db.prepare("UPDATE comparisons SET updated_at = ? WHERE id = ?").run(nowIso(), comparisonId);
    }
    // Files the reply's code made are copied here before the reply counts as done, so its cards
    // can link to them straight away. Files it wrote out with save_file are kept the same way.
    const written = kit.written();
    if ((result?.fileIds.length || written.length) && saved.status !== "failed" && saved.status !== "declined") {
      void send("status", { status: "saving" });
      const fromCode = result?.fileIds.length
        ? await keepFiles(used.provider, decryptSecret(used.encrypted_key), result.fileIds, saved.id, convId)
        : { files: [], failed: 0 };
      const fromText = keepWrittenFiles(written, saved.id, convId);
      const kept = { files: [...fromCode.files, ...fromText.files], failed: fromCode.failed + fromText.failed };
      saved.files = kept.files;
      if (kept.failed) {
        const note = sentences(
          [saved.note, tn(kept.failed, "A file it made couldn't be saved", "{failed} files it made couldn't be saved", { failed: kept.failed })].filter(
            (s): s is string => !!s,
          ),
        );
        db.prepare("UPDATE messages SET note = ? WHERE id = ?").run(note, saved.id);
        saved.note = note;
      }
    }
    release();
    if (saved.status === "ok" || saved.status === "truncated" || saved.status === "stopped") {
      await send("done", { message: saved });
    } else {
      await send("error", { message: saved });
    }

    // The reply is done and the chat is free again; naming it happens on the same stream after.
    if (!unattended && (saved.status === "ok" || saved.status === "truncated")) {
      const newTitle = await maybeRetitle(convId, user.id, used, saved.id);
      if (newTitle) await send("title", { title: newTitle });
    }
    return saved;
  };
  let running: Promise<PublicMessage> | undefined;
  const run = (send: ChatSender = async () => {}) => {
    // Preparing once can only cause one provider call, even if two callers await the runner.
    running ??= Promise.resolve().then(() => execute(send)).finally(release);
    return running;
  };
  return {
    conversationId: convId,
    run,
    cancel: () => {
      controller.abort();
      // A prepared reply cancelled before run still saves its stopped state and frees its slot.
      void run().catch(() => {});
    },
  };
}

chatRoutes.post("/chat", async (c) => {
  let prepared: PreparedChat;
  try {
    const body = await c.req.json().catch(() => ({}));
    prepared = await prepareChat(c.var.user!, body && typeof body === "object" ? body : {});
  } catch (err) {
    if (err instanceof ChatStartError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    throw err;
  }
  return streamSSE(c, async (stream) => {
    // Writes go out in order; once the browser leaves they're skipped, but the reply carries on
    // and is saved, so it's there when the person comes back.
    let queue = Promise.resolve();
    const send: ChatSender = (event, data) => {
      queue = queue.then(async () => {
        if (stream.aborted || stream.closed) return;
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        } catch {
          // The browser went away.
        }
      });
      return queue;
    };
    const heartbeat = setInterval(() => {
      queue = queue.then(async () => {
        if (stream.aborted || stream.closed) return clearInterval(heartbeat);
        try {
          await stream.write(": keep-alive\n\n");
        } catch {
          // The browser went away.
        }
      });
    }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      await prepared.run(send);
    } finally {
      clearInterval(heartbeat);
    }
  });
});

type Outcome = {
  convId: string;
  userId: number;
  userMessageId: number;
  /** The key that produced (or failed to produce) the reply: the chat's key or its backup. */
  key: KeyRow;
  partial: string;
  result: ChatResult | null;
  /** Some providers finish their iterator normally on abort, still returning partial text and usage. */
  stopped: boolean;
  failure: string | null;
  note: string | null;
  thinking: string | null;
  thinkingMs: number | null;
  /** What the reply did with the app's tools. */
  tools: ToolUse[];
  /** Addresses its searches returned and pages the person let it read, which later replies may read unasked. */
  pageUrls: string[];
};

/**
 * Stores the reply. Declined, failed and empty stopped replies stay readable for admins but
 * leave the context, together with the message that prompted them.
 */
function saveOutcome({ convId, userId, userMessageId, key, partial, result, stopped, failure, note, thinking, thinkingMs, tools, pageUrls }: Outcome) {
  const now = nowIso();
  return tx(() => {
    let row: Omit<
      MessageRow,
      | "id" | "conversation_id" | "parent_id" | "role" | "created_at" | "note" | "thinking" | "thinking_ms" | "instructions" | "declined_by"
      | "reviewed_at" | "reviewed_by" | "web" | "search_off" | "code_off" | "tools" | "context_tokens" | "page_urls"
    >;
    // A reply with no words (nothing, or thinking only) is a failure, shown with "Try again"; it
    // stays out of what's sent back, like any failed reply.
    const empty = !!result && !result.refused && !result.text.trim();
    if (stopped || (!result && !failure)) {
      // The user's stop wins even when the provider returns a normal result. Keep its text and
      // usage, but replay an interrupted Claude turn as plain text rather than unfinished blocks.
      const text = result?.text || partial;
      const kept = text.trim() ? 1 : 0;
      row = {
        text,
        content: kept && key.provider === "anthropic" ? JSON.stringify([{ type: "text", text }]) : null,
        provider: key.provider,
        model: result?.model ?? key.model,
        stop_reason: "aborted",
        error: null,
        in_context: kept,
      };
    } else if (result && !result.refused && !empty) {
      row = {
        text: result.text,
        content: result.content ? JSON.stringify(result.content) : null,
        provider: key.provider,
        model: result.model,
        stop_reason: result.stopReason,
        error: null,
        in_context: 1,
      };
    } else if (result && empty) {
      row = { text: "", content: null, provider: key.provider, model: result.model, stop_reason: "error", error: t("No reply came back. Try again"), in_context: 0 };
    } else if (result?.refused) {
      row = { text: partial, content: null, provider: key.provider, model: result.model, stop_reason: "refusal", error: t("The AI declined to answer this message"), in_context: 0 };
    } else {
      row = { text: partial, content: null, provider: key.provider, model: key.model, stop_reason: "error", error: failure, in_context: 0 };
    }

    // The prompt's own flag only feeds admin listings; what reaches the model is worked out
    // from the branch (historyFor), so a later successful regenerate brings the prompt back in.
    db.prepare("UPDATE messages SET in_context = ? WHERE id = ?").run(row.in_context, userMessageId);
    // A Claude model declined and a fallback model answered: kept for the admins' declined review.
    const declined = result && !result.refused ? declinedBy(result.content) : null;
    // What it searched for and cited, shown under the reply.
    const web = result && (result.searches.length || result.sources.length)
      ? JSON.stringify({ searches: result.searches, sources: result.sources, found: result.sources.length ? [] : result.found })
      : null;

    const toolsJson = tools.length ? JSON.stringify(tools) : null;
    const pageUrlsJson = pageUrls.length ? JSON.stringify(pageUrls) : null;
    const contextTokens = result?.contextTokens || null;
    const id = Number(
      db
        .prepare(
          `INSERT INTO messages (conversation_id, parent_id, role, text, content, provider, model, stop_reason, error, note,
             thinking, thinking_ms, in_context, declined_by, web, tools, context_tokens, page_urls, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(convId, userMessageId, row.text, row.content, row.provider, row.model, row.stop_reason, row.error, note,
          thinking, thinkingMs, row.in_context, declined, web, toolsJson, contextTokens, pageUrlsJson, now)
        .lastInsertRowid,
    );

    if (result) {
      const cost = estimateCost(keyModel(key, key.model), result.usage, key.provider);
      db.prepare(
        `INSERT INTO usage_events (user_id, api_key_id, key_label, provider, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, web_searches, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        result.usage.webSearches ?? 0,
        cost,
        now,
      );
    }
    db.prepare("UPDATE conversations SET updated_at = ?, head_id = ? WHERE id = ?").run(now, id, convId);

    return toPublic({
      id,
      conversation_id: convId,
      parent_id: userMessageId,
      role: "assistant",
      created_at: now,
      note,
      thinking,
      thinking_ms: thinkingMs,
      instructions: null,
      declined_by: declined,
      reviewed_at: null,
      reviewed_by: null,
      web,
      search_off: 0,
      code_off: 0,
      tools: toolsJson,
      context_tokens: contextTokens,
      page_urls: pageUrlsJson,
      ...row,
    });
  });
}
