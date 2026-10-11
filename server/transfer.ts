// Taking your chats away and bringing them in. An export is one JSON file: your personas,
// memory, projects and every chat with all its versions. An import reads that file back, or the
// conversations.json from a ChatGPT or Claude export (the .zip they send, or the file from inside it).
// Imported chats carry on like any other; their earlier replies go back to the model as plain text.
import { randomUUID } from "node:crypto";
import { toPublic, tx, type ConversationRow, type MessageRow } from "./chat-store.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";
import { t } from "./i18n.ts";
import {
  getInstructions, instructionsJson, MAX_INSTRUCTION_CHARS, parseInstructions, personalOnly, personasOf, systemPromptFor, type PersonalInstructions,
} from "./instructions.ts";
import { MAX_MEMORIES_VERIFIED, memoriesOf, memoryLimit, memoryOn, memoryPrompt, saveMemory, cleanMemory } from "./memory.ts";
import { chatSetting, MAX_PROJECT_INSTRUCTIONS, MAX_PROJECTS, ownProject, type ProjectRow } from "./projects.ts";
import { codeOnSite, searchOnSite, toolsForNewChat } from "./tools.ts";
import { isZip, readZip } from "./zip.ts";

/** What's wrong with a file brought in, said to the person who brought it (routes/me.ts shows it). */
export class ImportError extends Error {}

export const EXPORT_FORMAT = "parley-export";
const MAX_CHATS = 5000;
const MAX_TEXT = 500_000;
/** The most an export's JSON may be, sent as it is or inside a zip. */
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

type ExportedMessage = {
  id: number;
  parentId: number | null;
  role: "user" | "assistant";
  text: string;
  thinking?: string | null;
  model?: string;
  status?: string;
  error?: string | null;
  sources?: { url: string; title: string }[];
  attachments?: string[];
  files?: string[];
  createdAt: string;
};
type ExportedChat = {
  id: string;
  title: string;
  projectId: string | null;
  pinned?: boolean;
  instructions?: PersonalInstructions;
  createdAt: string;
  updatedAt: string;
  headId: number | null;
  messages: ExportedMessage[];
};
type ExportFile = {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  site: string;
  account: { email: string };
  /** What new chats start with: the persona picked for them. */
  instructions: PersonalInstructions;
  personas?: { name: string; aboutMe: string; answerStyle: string; forNewChats: boolean }[];
  memories: { text: string; createdAt: string }[];
  projects: { id: string; name: string; instructions: string; createdAt: string }[];
  chats: ExportedChat[];
};

/** Everything a person keeps here, as one file. Files' bytes stay behind; their names go. */
export function exportFor(userId: number, email: string): ExportFile {
  const projects = db.prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at").all(userId) as ProjectRow[];
  const convs = db
    .prepare("SELECT * FROM conversations WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at")
    .all(userId) as ConversationRow[];
  const allMessages = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id");
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: nowIso(),
    site: env.appName,
    account: { email },
    instructions: getInstructions(userId),
    personas: personasOf(userId).map(({ id: _id, ...p }) => p),
    memories: memoriesOf(userId).map((m) => ({ text: m.text, createdAt: m.created_at })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, instructions: p.instructions, createdAt: p.created_at })),
    chats: convs.map((cv) => ({
      id: cv.id,
      title: cv.title,
      projectId: cv.project_id,
      pinned: !!cv.pinned_at,
      instructions: personalOnly(parseInstructions(cv.chat_instructions)),
      createdAt: cv.created_at,
      updatedAt: cv.updated_at,
      headId: cv.head_id,
      messages: (allMessages.all(cv.id) as MessageRow[]).map((m) => {
        const p = toPublic(m, []);
        return {
          id: m.id,
          parentId: m.parent_id,
          role: m.role,
          text: m.text,
          ...(p.thinking ? { thinking: p.thinking } : {}),
          ...(m.role === "assistant" ? { model: p.model, status: p.status } : {}),
          ...(p.error ? { error: p.error } : {}),
          ...(p.sources.length ? { sources: p.sources } : {}),
          ...(p.attachments.length ? { attachments: p.attachments.map((a) => a.name) } : {}),
          ...(p.files.length ? { files: p.files.map((f) => f.name) } : {}),
          createdAt: m.created_at,
        };
      }),
    })),
  };
}

// ── Reading what's brought in ───────────────────────────────────────

/** One message to add: who wrote it, its words, what model, when, and which message it follows (by index). */
type Incoming = { role: "user" | "assistant"; text: string; model?: string; thinking?: string | null; createdAt: string; parent: number | null; failed?: string | null };
type IncomingChat = {
  key: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Incoming[];
  /** Index of the message on screen (the end of the branch shown); the last one when unset. */
  head?: number;
  projectId?: string | null;
  pinned?: boolean;
  instructions?: PersonalInstructions;
};

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n\n(Cut short when it was imported.)` : s);
/** A chat's own instructions from the file, held to the same length as when they're edited. */
function fromFile(instructions: PersonalInstructions): PersonalInstructions {
  const { aboutMe, answerStyle } = personalOnly(parseInstructions(JSON.stringify(instructions)));
  return { aboutMe: aboutMe.trim().slice(0, MAX_INSTRUCTION_CHARS), answerStyle: answerStyle.trim().slice(0, MAX_INSTRUCTION_CHARS) };
}

/** A time from the file (seconds, milliseconds or text), as ISO; now if it's unreadable or still to come. */
const iso = (v: unknown, now: string): string => {
  const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  const date = new Date(ms);
  // A Date holds about 275,000 years either way; past that it's invalid, and toISOString throws.
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.parse(now)) return now;
  return date.toISOString();
};

/**
 * A straight line of messages: neighbours from the same side join into one, since the chat here
 * goes person, AI, person. Empty ones go.
 */
function linear(list: Omit<Incoming, "parent">[]): Incoming[] {
  const out: Incoming[] = [];
  for (const m of list) {
    const text = m.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.text = `${last.text}\n\n${text}`;
      continue;
    }
    out.push({ ...m, text, parent: out.length ? out.length - 1 : null });
  }
  return out;
}

type ChatGptNode = {
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[]; text?: string };
    create_time?: number | null;
    metadata?: { model_slug?: string; is_visually_hidden_from_conversation?: boolean };
  } | null;
  parent?: string | null;
};

/** A ChatGPT conversation: the branch that was on screen, from its first message. */
function fromChatGpt(c: Record<string, unknown>, now: string): IncomingChat | null {
  const mapping = c.mapping as Record<string, ChatGptNode> | undefined;
  if (!mapping || typeof mapping !== "object") return null;
  const path: ChatGptNode[] = [];
  let at = typeof c.current_node === "string" ? c.current_node : null;
  const seen = new Set<string>();
  while (at && mapping[at] && !seen.has(at)) {
    seen.add(at);
    path.unshift(mapping[at]);
    at = mapping[at].parent ?? null;
  }
  const messages = linear(
    path.flatMap((node) => {
      const m = node.message;
      const role = m?.author?.role;
      if (!m || (role !== "user" && role !== "assistant") || m.metadata?.is_visually_hidden_from_conversation) return [];
      const type = m.content?.content_type;
      if (type !== "text" && type !== "multimodal_text" && type !== "code") return [];
      const parts = (m.content?.parts ?? []).filter((p): p is string => typeof p === "string");
      const text = type === "code" ? `\`\`\`\n${m.content?.text ?? ""}\n\`\`\`` : parts.join("\n\n");
      return [{ role, text: clip(text), model: role === "assistant" ? (m.metadata?.model_slug ?? "ChatGPT") : undefined, createdAt: iso(m.create_time, now) }];
    }),
  );
  if (!messages.length) return null;
  return {
    key: `chatgpt:${String(c.conversation_id ?? c.id ?? randomUUID())}`,
    title: String(c.title ?? "") || t("Imported chat"),
    createdAt: iso(c.create_time, now),
    updatedAt: iso(c.update_time, now),
    messages,
  };
}

type ClaudeMessage = { sender?: string; text?: string; content?: { type?: string; text?: string }[]; created_at?: string; attachments?: { file_name?: string }[]; files?: { file_name?: string }[] };

/** A conversation from a Claude export: its messages in order. */
function fromClaude(c: Record<string, unknown>, now: string): IncomingChat | null {
  const list = c.chat_messages as ClaudeMessage[] | undefined;
  if (!Array.isArray(list)) return null;
  const messages = linear(
    list.flatMap((m) => {
      const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
      if (!role) return [];
      const fromBlocks = (m.content ?? []).filter((b) => b?.type === "text" && b.text).map((b) => b.text!).join("\n\n");
      let text = fromBlocks || m.text || "";
      const names = [...(m.attachments ?? []), ...(m.files ?? [])].map((f) => f.file_name).filter(Boolean);
      if (names.length && role === "user") text = `${text}\n\n(Attached in the original chat: ${names.join(", ")})`;
      return [{ role, text: clip(text), model: role === "assistant" ? "Claude" : undefined, createdAt: iso(m.created_at, now) }];
    }),
  );
  if (!messages.length) return null;
  return {
    key: `claude:${String(c.uuid ?? randomUUID())}`,
    title: String(c.name ?? "") || t("Imported chat"),
    createdAt: iso(c.created_at, now),
    updatedAt: iso(c.updated_at, now),
    messages,
  };
}

/** A chat from a Parley export, every version of every message kept. */
function fromParley(c: ExportedChat, now: string): IncomingChat | null {
  if (!Array.isArray(c.messages) || !c.messages.length) return null;
  const index = new Map<number, number>();
  const messages: Incoming[] = [];
  for (const m of c.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const parent = m.parentId == null ? null : index.get(m.parentId);
    if (parent === undefined) continue;
    index.set(m.id, messages.length);
    const failed = m.role === "assistant" && (m.status === "failed" || m.status === "declined") ? (m.error ?? t("No reply came back")) : null;
    messages.push({ role: m.role, text: clip(String(m.text ?? "")), model: m.model, thinking: m.thinking ?? null, createdAt: iso(m.createdAt, now), parent, failed });
  }
  if (!messages.length) return null;
  return {
    key: `parley:${c.id}`,
    title: String(c.title ?? "") || t("Imported chat"),
    createdAt: iso(c.createdAt, now),
    updatedAt: iso(c.updatedAt, now),
    messages,
    head: c.headId != null ? index.get(c.headId) : undefined,
    projectId: c.projectId,
    pinned: !!c.pinned,
    instructions: c.instructions,
  };
}

export type ImportResult = { chats: number; skipped: number; projects: number; memories: number; source: "parley" | "chatgpt" | "claude" };

/** What the file holds, read: the JSON, or the conversations.json inside a zip. */
function readUpload(bytes: Buffer): unknown {
  let json = bytes;
  if (isZip(bytes)) {
    const entries = readZip(bytes);
    const entry = entries?.find((e) => /(^|\/)conversations\.json$/i.test(e.name)) ?? entries?.find((e) => /\.json$/i.test(e.name));
    if (!entry) throw new ImportError(t("There's no conversations.json in that archive"));
    if (entry.size > MAX_IMPORT_BYTES) throw new ImportError(t("That export is over {MAX_IMPORT_BYTES} MB unpacked", { MAX_IMPORT_BYTES: MAX_IMPORT_BYTES / (1024 * 1024) }));
    try {
      json = entry.read(MAX_IMPORT_BYTES);
    } catch {
      throw new ImportError(t("That archive is damaged. Download the export again"));
    }
  }
  try {
    return JSON.parse(json.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new ImportError(t("That file isn't an export this can read. Use a Parley export, or conversations.json from ChatGPT or Claude"));
  }
}

/** Brings chats (and, from a Parley export, projects and memory) into this person's account. */
export function importFor(userId: number, bytes: Buffer): ImportResult {
  const data = readUpload(bytes);
  const now = nowIso();
  let source: ImportResult["source"];
  let chats: IncomingChat[];
  let projects: ExportFile["projects"] = [];
  let memories: ExportFile["memories"] = [];
  if (data && typeof data === "object" && (data as ExportFile).format === EXPORT_FORMAT) {
    const file = data as ExportFile;
    source = "parley";
    chats = (file.chats ?? []).map((c) => fromParley(c, now)).filter((c): c is IncomingChat => !!c);
    projects = Array.isArray(file.projects) ? file.projects : [];
    memories = Array.isArray(file.memories) ? file.memories : [];
  } else if (Array.isArray(data) && data.some((c) => c && typeof c === "object" && "mapping" in c)) {
    source = "chatgpt";
    chats = data.map((c) => fromChatGpt(c as Record<string, unknown>, now)).filter((c): c is IncomingChat => !!c);
  } else if (Array.isArray(data) && data.some((c) => c && typeof c === "object" && "chat_messages" in c)) {
    source = "claude";
    chats = data.map((c) => fromClaude(c as Record<string, unknown>, now)).filter((c): c is IncomingChat => !!c);
  } else {
    throw new ImportError(t("That file isn't an export this can read. Use a Parley export, or conversations.json from ChatGPT or Claude"));
  }
  if (chats.length > MAX_CHATS) throw new ImportError(t("An import can bring in up to {MAX_CHATS} chats at a time", { MAX_CHATS }));

  // Every imported chat starts the way a new one would, with the person's defaults today.
  const personal = getInstructions(userId);
  const memory = memoryOn(userId) ? memoryPrompt(userId) : null;
  const tools = toolsForNewChat(userId);
  const toolsJson = tools.length ? JSON.stringify(tools) : null;
  const search = searchOnSite() ? 1 : 0;
  const code = codeOnSite() ? 1 : 0;
  const known = new Set(
    (db.prepare("SELECT import_key FROM conversations WHERE user_id = ? AND import_key IS NOT NULL").all(userId) as { import_key: string }[]).map((r) => r.import_key),
  );

  return tx(() => {
    // Projects come in as new ones, unless one of the same name is here already, while there's room
    // (an export holds no more than one account can have). Chats in a project left out come in loose.
    const projectIds = new Map<string, string>();
    let newProjects = 0;
    let projectCount = (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(userId) as { n: number }).n;
    for (const p of projects.slice(0, MAX_PROJECTS)) {
      const name = String(p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!name) continue;
      const same = db.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ?").get(userId, name) as { id: string } | undefined;
      if (same) {
        projectIds.set(p.id, same.id);
        continue;
      }
      if (projectCount >= MAX_PROJECTS) continue;
      const id = randomUUID();
      db.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id, userId, name, String(p.instructions ?? "").trim().slice(0, MAX_PROJECT_INSTRUCTIONS), iso(p.createdAt, now), now,
      );
      projectIds.set(p.id, id);
      newProjects++;
      projectCount++;
    }
    // Notes come in until memory is full; the ones kept already are found, not added again.
    let newMemories = 0;
    const limit = memoryLimit(userId);
    const kept = new Set(memoriesOf(userId).map((m) => m.id));
    for (const m of memories.slice(0, MAX_MEMORIES_VERIFIED)) {
      if (kept.size >= limit) break;
      const text = cleanMemory(m.text);
      if (!text) continue;
      const saved = saveMemory(userId, text, null);
      if ("error" in saved) break;
      if (!kept.has(saved.id)) {
        kept.add(saved.id);
        newMemories++;
      }
    }

    let added = 0;
    let skipped = 0;
    const insertMessage = db.prepare(
      `INSERT INTO messages (conversation_id, parent_id, role, text, provider, model, stop_reason, error, thinking, in_context, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    );
    for (const chat of chats) {
      if (known.has(chat.key)) {
        skipped++;
        continue;
      }
      known.add(chat.key);
      const id = randomUUID();
      const projectId = chat.projectId ? (projectIds.get(chat.projectId) ?? (ownProject(chat.projectId, userId)?.id ?? null)) : null;
      const own = chat.instructions ? fromFile(chat.instructions) : personal;
      db.prepare(
        `INSERT INTO conversations (id, user_id, title, system_prompt, chat_instructions, sealed_instructions, web_search_tool, code_tool,
           project_id, pinned_at, tool_defs, title_auto, import_key, imported_at, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        id, userId, chat.title.replace(/\s+/g, " ").trim().slice(0, 120) || t("Imported chat"), instructionsJson(own), search, code,
        projectId, chat.pinned ? now : null, toolsJson, chat.key, now, chat.createdAt, chat.updatedAt,
      );
      const setting = chatSetting(own, userId, id, projectId);
      db.prepare("UPDATE conversations SET system_prompt = ?, sealed_instructions = ? WHERE id = ?").run(
        systemPromptFor(setting, memory),
        instructionsJson(setting),
        id,
      );
      const ids: number[] = [];
      for (const m of chat.messages) {
        const parent = m.parent == null ? null : ids[m.parent];
        const failed = m.role === "assistant" && m.failed;
        const row = insertMessage.run(
          id, parent ?? null, m.role, m.text, m.role === "assistant" ? (m.model ?? null) : null,
          failed ? "error" : m.role === "assistant" ? "end_turn" : null, failed || null, m.thinking ?? null, failed ? 0 : 1, m.createdAt,
        );
        ids.push(Number(row.lastInsertRowid));
      }
      const head = ids[chat.head ?? ids.length - 1] ?? ids[ids.length - 1];
      db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(head, id);
      added++;
    }
    return { chats: added, skipped, projects: newProjects, memories: newMemories, source };
  });
}
