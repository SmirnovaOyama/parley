import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireUser, type AppEnv } from "../auth.ts";
import {
  declinedBy,
  getConversation,
  getMessage,
  historyFor,
  instructionsBefore,
  newestLeaf,
  titleFrom,
  toPublic,
  tx,
  viewPath,
  type ConversationRow,
  type MessageRow,
} from "../chat-store.ts";
import { allowanceOf, overLimitMessage } from "../allowance.ts";
import { decryptSecret } from "../crypto.ts";
import { db, getSettings, nowIso } from "../db.ts";
import { availableKeys, keyById, pickerChoices, startingKey, withChoice, type KeyRow } from "../keys.ts";
import { estimateCost, modelLabel } from "../providers/catalog.ts";
import { describeProviderError, getProvider, shouldUseBackup } from "../providers/index.ts";
import {
  cleanInstructions,
  getInstructions,
  instructionsJson,
  parseInstructions,
  sameInstructions,
  systemPromptFor,
} from "../instructions.ts";
import { maybeRetitle } from "../titles.ts";
import { shareOf, shareOut, shareUpTo, stopSharing } from "../shares.ts";
import { fileHeaders, keepFiles, storedFile } from "../files.ts";
import type { ChatResult } from "../providers/types.ts";

export const chatRoutes = new Hono<AppEnv>();
chatRoutes.use("*", requireUser);

const MAX_MESSAGE_CHARS = 50_000;
const MESSAGES_PER_MINUTE = 20;

/** Replies being written right now, so a person can stop one or come back to it. */
const generating = new Map<string, { controller: AbortController; userId: number }>();
const recentSends = new Map<number, number[]>();

/** Some Claude key has web search on, so new chats declare the search tool. */
function searchOnSite(): boolean {
  return !!db.prepare("SELECT 1 FROM api_keys WHERE provider = 'anthropic' AND web_search = 1 LIMIT 1").get();
}

/** Some Claude key may make files, so new chats declare the code execution tool. */
function codeOnSite(): boolean {
  return !!db.prepare("SELECT 1 FROM api_keys WHERE provider = 'anthropic' AND code_execution = 1 LIMIT 1").get();
}

function ownConversation(id: string, userId: number) {
  const conv = getConversation(id);
  return conv && conv.user_id === userId && !conv.deleted_at ? conv : undefined;
}

function rateLimited(userId: number): boolean {
  const now = Date.now();
  const times = (recentSends.get(userId) ?? []).filter((t) => now - t < 60_000);
  times.push(now);
  recentSends.set(userId, times);
  return times.length > MESSAGES_PER_MINUTE;
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

chatRoutes.get("/conversations", (c) => {
  const rows = db
    .prepare(
      `SELECT cv.id, cv.title, cv.updated_at, EXISTS (SELECT 1 FROM shares s WHERE s.conversation_id = cv.id) AS shared
       FROM conversations cv WHERE cv.user_id = ? AND cv.deleted_at IS NULL ORDER BY cv.updated_at DESC LIMIT 200`,
    )
    .all(c.var.user!.id) as { id: string; title: string; updated_at: string; shared: number }[];
  return c.json({
    // generating: a reply is being written for it right now (the chat list shows a spinner).
    conversations: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, shared: !!r.shared, generating: generating.has(r.id) })),
  });
});

chatRoutes.get("/conversations/:id", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  return c.json({
    conversation: {
      id: conv.id,
      title: conv.title,
      updatedAt: conv.updated_at,
      keyId: conv.api_key_id,
      model: conv.model,
      effort: conv.effort,
      instructions: parseInstructions(conv.chat_instructions),
    },
    messages: viewPath(conv),
    generating: generating.has(conv.id),
    share: shareInfo(conv),
    sharing: getSettings().sharing,
  });
});

function shareInfo(conv: ConversationRow) {
  const share = shareOf(conv.id);
  return share ? shareOut(share) : null;
}

/** Makes a read-only link to the chat as it is now, or moves the existing link up to now. */
chatRoutes.post("/conversations/:id/share", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  if (getSettings().sharing === "off") return c.json({ error: "An admin has turned sharing off" }, 403);
  if (generating.has(conv.id)) return c.json({ error: "Wait for the reply to finish first" }, 409);
  if (conv.head_id == null) return c.json({ error: "There's nothing to share yet" }, 400);
  return c.json({ share: shareOut(shareUpTo(conv)) });
});

chatRoutes.delete("/conversations/:id/share", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
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
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  const parts = [`# ${conv.title}`];
  for (const m of viewPath(conv)) {
    if (m.role === "user") {
      parts.push(`**You**\n\n${m.text}`);
      continue;
    }
    let body = m.text.trim();
    if (m.status === "declined") body = "_The AI declined to answer this message_";
    else if (m.status === "failed") body = "_No reply came back_";
    else if (!body) continue;
    if (m.sources.length) body += `\n\nSources:\n${m.sources.map((src, i) => `${i + 1}. [${src.title || src.url}](${src.url})`).join("\n")}`;
    parts.push(`**${m.model || "AI"}**\n\n${body}`);
  }
  const name = conv.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Chat";
  const ascii = name.replace(/[^\x20-\x7e]+/g, "").trim() || "chat";
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${ascii.replace(/"/g, "")}.md"; filename*=UTF-8''${encodeURIComponent(name)}.md`);
  c.header("Cache-Control", "private, no-store");
  return c.body(`${parts.join("\n\n---\n\n")}\n`);
});

/** A file a reply made: for the chat's owner, and admins (who can read every chat). */
chatRoutes.get("/files/:id", (c) => {
  const file = storedFile(c.req.param("id"));
  const owner = file
    ? (db.prepare("SELECT cv.user_id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE m.id = ?").get(file.message_id) as
        | { user_id: number }
        | undefined)
    : undefined;
  const user = c.var.user!;
  if (!file || !owner || (owner.user_id !== user.id && user.role !== "admin") || !existsSync(file.path)) {
    return c.json({ error: "This file isn't here any more" }, 404);
  }
  for (const [name, value] of Object.entries(fileHeaders(file, c.req.query("inline") === "1"))) c.header(name, value);
  return c.body(readFileSync(file.path));
});

/** This chat's own instructions. A change applies from the next message, as a system note. */
chatRoutes.put("/conversations/:id/instructions", async (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  const cleaned = cleanInstructions(await c.req.json().catch(() => ({})));
  if (!cleaned) return c.json({ error: "Keep each instruction under 1500 characters" }, 400);
  db.prepare("UPDATE conversations SET chat_instructions = ? WHERE id = ?").run(instructionsJson(cleaned), conv.id);
  return c.json(cleaned);
});

/** Shows another version of a message: the chat follows that version's newest branch. */
chatRoutes.post("/conversations/:id/branch", async (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  if (generating.has(conv.id)) return c.json({ error: "Wait for the reply to finish first" }, 409);
  const body = await c.req.json().catch(() => ({}));
  const message = getMessage(Number(body.messageId));
  if (!message || message.conversation_id !== conv.id) return c.json({ error: "That message isn't in this chat" }, 400);
  const head = newestLeaf(message.id);
  db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(head, conv.id);
  return c.json({ messages: viewPath({ ...conv, head_id: head }) });
});

chatRoutes.patch("/conversations/:id", async (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!title) return c.json({ error: "Give the chat a name" }, 400);
  // A name someone chose is never rewritten by the automatic titles.
  db.prepare("UPDATE conversations SET title = ?, title_auto = 0 WHERE id = ?").run(title, conv.id);
  return c.json({ ok: true });
});

// Deleting hides the chat from its owner; admins keep it for their records (the prompt says so).
chatRoutes.delete("/conversations/:id", (c) => {
  const conv = ownConversation(c.req.param("id"), c.var.user!.id);
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  generating.get(conv.id)?.controller.abort();
  db.prepare("UPDATE conversations SET deleted_at = ? WHERE id = ?").run(nowIso(), conv.id);
  // A deleted chat's link stops working with it.
  stopSharing(conv.id);
  return c.json({ ok: true });
});

chatRoutes.post("/conversations/:id/stop", (c) => {
  const job = generating.get(c.req.param("id"));
  if (job && job.userId === c.var.user!.id) job.controller.abort();
  return c.json({ ok: true });
});

/**
 * Sends a message and streams the reply. Three ways in:
 * - `text`: a new message at the end of the branch on screen (or the first of a new chat);
 * - `text` + `parentId`: an edit, a new version of the message that followed `parentId`
 *   (null for the first message), so the old version and its replies stay as a branch;
 * - `regenerate`: a new version of the reply to that user message, with no new message.
 */
chatRoutes.post("/chat", async (c) => {
  const user = c.var.user!;
  const body = await c.req.json().catch(() => ({}));
  const regenerate = body.regenerate != null ? Number(body.regenerate) : null;
  const editing = regenerate == null && body.parentId !== undefined;
  const text = String(body.text ?? "").trim();
  if (regenerate == null && !text) return c.json({ error: "Write a message first" }, 400);
  if (text.length > MAX_MESSAGE_CHARS) return c.json({ error: "That message is too long" }, 400);

  let conversationId = body.conversationId ? String(body.conversationId) : null;
  const existing = conversationId ? ownConversation(conversationId, user.id) : undefined;
  if (conversationId && !existing) return c.json({ error: "This chat doesn't exist" }, 404);
  if ((editing || regenerate != null) && !existing) return c.json({ error: "This chat doesn't exist" }, 404);
  if (conversationId && generating.has(conversationId)) {
    return c.json({ error: "A reply is still being written in this chat" }, 409);
  }

  // Where the new message (or regenerated reply) attaches in the tree.
  let parentId: number | null = existing?.head_id ?? null;
  if (regenerate != null) {
    const prompt = getMessage(regenerate);
    if (!prompt || prompt.conversation_id !== conversationId || prompt.role !== "user") {
      return c.json({ error: "That message isn't in this chat" }, 400);
    }
    parentId = prompt.id;
  } else if (editing) {
    parentId = body.parentId === null ? null : Number(body.parentId);
    const parent = parentId == null ? null : getMessage(parentId);
    if (parentId != null && (!parent || parent.conversation_id !== conversationId || parent.role !== "assistant")) {
      return c.json({ error: "That message isn't in this chat" }, 400);
    }
  }

  // The key, model and thinking level asked for, else what this chat used last, else the person's
  // starting key as it starts. A model or level the key doesn't offer falls back to its own.
  const available = availableKeys(user.id);
  const requested = body.keyId != null ? Number(body.keyId) : (existing?.api_key_id ?? null);
  const picked = available.find((k) => k.id === requested) ?? startingKey(user.id, available);
  if (!picked) return c.json({ error: "No AI model is set up yet. Ask an admin to add one" }, 409);
  const sameKey = existing?.api_key_id === picked.id;
  const key = withChoice(
    picked,
    body.model != null ? String(body.model) : sameKey ? existing?.model : null,
    body.effort != null ? String(body.effort) : sameKey ? existing?.effort : null,
  );
  const overLimit = overLimitMessage(allowanceOf(user.id));
  if (overLimit) return c.json({ error: overLimit }, 429);
  if (rateLimited(user.id)) return c.json({ error: "You're sending messages quickly. Wait a moment and try again" }, 429);

  // A new chat starts with the instructions set on its page, or the person's Account defaults.
  let startInstructions = getInstructions(user.id);
  if (!existing && body.instructions !== undefined) {
    const cleaned = cleanInstructions(body.instructions);
    if (!cleaned) return c.json({ error: "Keep each instruction under 1500 characters" }, 400);
    startInstructions = cleaned;
  }

  const now = nowIso();
  const created = !conversationId;
  const title = created ? titleFrom(text) : existing!.title;
  // Whether this chat declares Claude's web search tool is settled when it starts: yes while any
  // Claude key has search on. It never changes after (see db.ts); each key's switch then decides.
  const searchTool = existing ? !!existing.web_search_tool : searchOnSite();
  // A new message in such a chat whose key has search off says so to the model (see db.ts).
  const searchOff = searchTool && key.provider === "anthropic" && !key.web_search;
  // Making files works the same way: declared from the start or never, then the key decides.
  const codeTool = existing ? !!existing.code_tool : codeOnSite();
  const codeOff = codeTool && key.provider === "anthropic" && !key.code_execution;
  // A chat keeps the system prompt it started with, so editing the site's or the chat's
  // instructions never rewrites a chat in progress. Chats from before prompts were kept started
  // with the site's instructions alone, so that's what they keep.
  const system = existing ? (existing.system_prompt ?? getSettings().systemPrompt) : systemPromptFor(startInstructions);
  // The chat's instructions changed since the model last saw them on this branch: the new message
  // carries them, and they go to the model as a system note right after it.
  const changedInstructions =
    existing && regenerate == null && existing.chat_instructions &&
    !sameInstructions(parseInstructions(existing.chat_instructions), parseInstructions(instructionsBefore(existing, parentId)))
      ? existing.chat_instructions
      : null;
  const userMessageId = tx(() => {
    if (!conversationId) {
      conversationId = randomUUID();
      const json = instructionsJson(startInstructions);
      db.prepare(
        `INSERT INTO conversations (id, user_id, title, api_key_id, model, effort, system_prompt, chat_instructions,
           sealed_instructions, web_search_tool, code_tool, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(conversationId, user.id, title, key.id, key.model, key.effort, system, json, json, searchTool ? 1 : 0, codeTool ? 1 : 0, now, now);
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
    db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(id, conversationId);
    return id;
  });
  const convId = conversationId!;

  const controller = new AbortController();
  generating.set(convId, { controller, userId: user.id });

  return streamSSE(c, async (stream) => {
    // Writes go out in order; once the browser leaves they're skipped, but the reply carries on
    // and is saved, so it's there when the person comes back.
    let queue = Promise.resolve();
    const send = (event: string, data: unknown) => {
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

    await send("meta", {
      conversationId: convId,
      title,
      created,
      userMessageId,
      keyId: key.id,
      model: modelLabel(key.provider, key.model),
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

    const attempt = (k: KeyRow) =>
      getProvider(k.provider).chat({
        apiKey: decryptSecret(k.encrypted_key),
        model: k.model,
        effort: k.effort,
        system,
        history,
        signal: controller.signal,
        showThinking,
        searchTool,
        searchAllowed,
        codeTool,
        codeAllowed,
        container: containerFor(k),
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
        result = await attempt(key);
      } catch (err) {
        // Before any text has arrived, a key or provider failure moves to the backup key once.
        const backup = keyById(key.fallback_key_id);
        if (controller.signal.aborted || partial || !backup || backup.id === key.id || !shouldUseBackup(err)) throw err;
        console.error(`[chat] ${key.provider}/${key.model} failed, trying backup "${backup.label}":`, err);
        used = backup;
        const note = `Answered with ${modelLabel(backup.provider, backup.model)} because ${modelLabel(key.provider, key.model)} was unavailable`;
        notes.push(note);
        void send("notice", { message: note });
        result = await attempt(backup);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        // Admins also see which key failed; everyone else never sees key names.
        failure = describeProviderError(err) + (user.role === "admin" ? ` (key “${used.label}”)` : "");
        console.error(`[chat] ${used.provider}/${used.model} failed:`, err);
      }
    } finally {
      generating.delete(convId);
    }

    if (thinkingStarted && thinkingMs == null) thinkingMs = Date.now() - thinkingStarted;
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
      failure,
      note: notes.join(". ") || null,
      thinking: thought.trim() || null,
      thinkingMs: thought.trim() ? thinkingMs : null,
    });
    // Files the reply's code made are copied here before the reply counts as done, so its cards
    // can link to them straight away.
    if (result?.fileIds.length && saved.status !== "failed" && saved.status !== "declined") {
      void send("status", { status: "saving" });
      const kept = await keepFiles(decryptSecret(used.encrypted_key), result.fileIds, saved.id, convId);
      saved.files = kept.files;
      if (kept.failed) {
        const note = [saved.note, `${kept.failed === 1 ? "A file" : `${kept.failed} files`} it made couldn't be saved`]
          .filter(Boolean)
          .join(". ");
        db.prepare("UPDATE messages SET note = ? WHERE id = ?").run(note, saved.id);
        saved.note = note;
      }
    }
    if (saved.status === "ok" || saved.status === "truncated" || saved.status === "stopped") {
      await send("done", { message: saved });
    } else {
      await send("error", { message: saved });
    }

    // The reply is done and the chat is free again; naming it happens on the same stream after.
    if (saved.status === "ok" || saved.status === "truncated") {
      const newTitle = await maybeRetitle(convId, user.id, used, saved.id);
      if (newTitle) await send("title", { title: newTitle });
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
  failure: string | null;
  note: string | null;
  thinking: string | null;
  thinkingMs: number | null;
};

/**
 * Stores the reply. Declined, failed and empty stopped replies stay readable for admins but
 * leave the context, together with the message that prompted them.
 */
function saveOutcome({ convId, userId, userMessageId, key, partial, result, failure, note, thinking, thinkingMs }: Outcome) {
  const now = nowIso();
  return tx(() => {
    let row: Omit<
      MessageRow,
      "id" | "conversation_id" | "parent_id" | "role" | "created_at" | "note" | "thinking" | "thinking_ms" | "instructions" | "declined_by" | "reviewed_at" | "reviewed_by" | "web" | "search_off" | "code_off"
    >;
    // A reply with no words (nothing, or thinking only) is a failure, shown with "Try again"; it
    // stays out of what's sent back, like any failed reply.
    const empty = !!result && !result.refused && !result.text.trim();
    if (result && !result.refused && !empty) {
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
      row = { text: "", content: null, provider: key.provider, model: result.model, stop_reason: "error", error: "No reply came back. Try again", in_context: 0 };
    } else if (result?.refused) {
      row = { text: partial, content: null, provider: key.provider, model: result.model, stop_reason: "refusal", error: "The AI declined to answer this message", in_context: 0 };
    } else if (failure) {
      row = { text: partial, content: null, provider: key.provider, model: key.model, stop_reason: "error", error: failure, in_context: 0 };
    } else {
      // Stopped by the person. Keep what was written as plain text.
      const kept = partial.trim() ? 1 : 0;
      row = {
        text: partial,
        content: kept && key.provider === "anthropic" ? JSON.stringify([{ type: "text", text: partial }]) : null,
        provider: key.provider,
        model: key.model,
        stop_reason: "aborted",
        error: null,
        in_context: kept,
      };
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

    const id = Number(
      db
        .prepare(
          `INSERT INTO messages (conversation_id, parent_id, role, text, content, provider, model, stop_reason, error, note,
             thinking, thinking_ms, in_context, declined_by, web, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(convId, userMessageId, row.text, row.content, row.provider, row.model, row.stop_reason, row.error, note,
          thinking, thinkingMs, row.in_context, declined, web, now)
        .lastInsertRowid,
    );

    if (result) {
      const cost = estimateCost(key.provider, key.model, result.usage);
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
      ...row,
    });
  });
}
