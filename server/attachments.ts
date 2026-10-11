// Files a person attaches to their message: images, PDFs, text and code files, and (in chats that
// can run code) anything else for Claude or GPT to open in its sandbox. Each is uploaded on its own
// before the message is sent, kept next to the database under a random name, and tied to the
// message when it goes. Claude reads them through its Files API, and OpenAI's sandbox takes them
// from its own: each file is uploaded once per account and referred to by id after that, so a long
// chat never sends the same bytes twice.
import { toFile } from "@anthropic-ai/sdk";
import { toFile as toOpenAIFile } from "openai";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { db, nowIso } from "./db.ts";
import { FILES_DIR, safeName } from "./files.ts";
import { readsFor, type KeyRow } from "./keys.ts";
import { hasTools } from "./providers/catalog.ts";
import { anthropicClient, OPENAI_API, openaiClient } from "./providers/clients.ts";
import { fileRef, type HistoryAttachment, type HistoryTurn } from "./providers/types.ts";

/** What a file is to the model: something to look at, read, or (other) open in code. */
export type AttachmentKind = "image" | "pdf" | "text" | "other";

export type AttachmentRow = {
  id: string;
  user_id: number;
  message_id: number | null;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  sha256: string;
  path: string;
  position: number;
  created_at: string;
};

/** Size limits. Claude takes images up to 5 MB; long text files would crowd out the chat. */
export const MAX_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
/** Files on one message, and uploads waiting to be sent, per person. */
export const MAX_PER_MESSAGE = 10;
const MAX_PENDING = 40;
/** Uploads nobody sent are cleared after a day. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * What the bytes are, read from the bytes themselves (never the browser's word): the four image
 * formats Claude reads, PDF, text in UTF-8, or something else.
 */
export function sniff(bytes: Buffer): { kind: AttachmentKind; mime: string } {
  const head = (s: string, at = 0) => bytes.subarray(at, at + s.length).toString("latin1") === s;
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return { kind: "image", mime: "image/png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (head("GIF87a") || head("GIF89a")) return { kind: "image", mime: "image/gif" };
  if (head("RIFF") && head("WEBP", 8)) return { kind: "image", mime: "image/webp" };
  if (head("%PDF-")) return { kind: "pdf", mime: "application/pdf" };
  if (!bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // Long text (a big CSV, say) is too much to read whole; code can still open it.
      return { kind: bytes.length > MAX_TEXT_BYTES ? "other" : "text", mime: "text/plain" };
    } catch {
      // Not UTF-8 text.
    }
  }
  return { kind: "other", mime: "application/octet-stream" };
}

/** The sentence for a file that's too big for its kind, or null when it fits. */
function tooBig(kind: AttachmentKind, size: number): string | null {
  if (kind === "image" && size > MAX_IMAGE_BYTES) return `Images can be up to ${mb(MAX_IMAGE_BYTES)}`;
  if (size > MAX_BYTES) return `Files can be up to ${mb(MAX_BYTES)}`;
  return null;
}

export type PublicAttachment = { id: string; name: string; mime: string; size: number; kind: AttachmentKind };

const toPublicAttachment = (a: Pick<AttachmentRow, "id" | "name" | "mime" | "size" | "kind">): PublicAttachment => ({
  id: a.id,
  name: a.name,
  mime: a.mime,
  size: a.size,
  kind: a.kind,
});

/** Keeps an upload until it's sent (or cleared). Returns a sentence instead when it can't be kept. */
export function saveUpload(userId: number, rawName: string, bytes: Buffer): PublicAttachment | { error: string } {
  if (!bytes.length) return { error: "This file is empty" };
  const pending = db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE user_id = ? AND message_id IS NULL").get(userId) as { n: number };
  if (pending.n >= MAX_PENDING) return { error: "Send or remove some of the files you've added first" };
  const { kind, mime } = sniff(bytes);
  const big = tooBig(kind, bytes.length);
  if (big) return { error: big };

  const id = randomBytes(12).toString("base64url");
  const name = safeName(rawName);
  const folder = join(FILES_DIR, "uploads", String(userId));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}${extname(name).slice(0, 12)}`);
  writeFileSync(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  db.prepare(
    `INSERT INTO attachments (id, user_id, message_id, name, mime, kind, size, sha256, path, position, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(id, userId, name, mime, kind, bytes.length, sha256, path, nowIso());
  return { id, name, mime, size: bytes.length, kind };
}

/** Removes an upload that hasn't been sent. Sent files stay: admins can read every chat. */
export function discardUpload(userId: number, id: string): boolean {
  const row = db.prepare("SELECT * FROM attachments WHERE id = ? AND user_id = ? AND message_id IS NULL").get(id, userId) as
    | AttachmentRow
    | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  removeUnused([row.path]);
  return true;
}

/** Deletes files on disk that no attachment row points to any more. */
export function removeUnused(paths: string[]) {
  const used = db.prepare("SELECT 1 FROM attachments WHERE path = ? UNION ALL SELECT 1 FROM message_files WHERE path = ? LIMIT 1");
  for (const path of new Set(paths)) {
    if (used.get(path, path)) continue;
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      console.error(`[attachments] couldn't remove ${path}:`, err);
    }
  }
}

/** Clears uploads that were never sent. Runs at start-up and every hour. */
export function clearStaleUploads() {
  const before = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  const rows = db.prepare("SELECT id, path FROM attachments WHERE message_id IS NULL AND created_at < ?").all(before) as { id: string; path: string }[];
  if (!rows.length) return;
  db.prepare("DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?").run(before);
  removeUnused(rows.map((r) => r.path));
}

export function attachmentsOf(messageId: number): PublicAttachment[] {
  return (
    db.prepare("SELECT id, name, mime, size, kind FROM attachments WHERE message_id = ? ORDER BY position, created_at").all(messageId) as Pick<
      AttachmentRow,
      "id" | "name" | "mime" | "size" | "kind"
    >[]
  ).map(toPublicAttachment);
}

/** What the model needs to rebuild a message's files: their names, kinds and where the bytes are. */
export function historyAttachments(messageId: number): HistoryAttachment[] {
  return db
    .prepare("SELECT name, mime, kind, size, sha256, path FROM attachments WHERE message_id = ? ORDER BY position, created_at")
    .all(messageId) as HistoryAttachment[];
}

/**
 * The files for a new message, in the order given: the person's own uploads waiting to be sent,
 * or (when editing) files already on a message in this chat, which the new version keeps too.
 * Returns a sentence when one of them can't be used.
 */
export function pickAttachments(userId: number, conversationId: string | null, ids: unknown): AttachmentRow[] | { error: string } {
  if (ids == null) return [];
  if (!Array.isArray(ids)) return { error: "Those files couldn't be found" };
  const unique = [...new Set(ids.map(String))];
  if (unique.length > MAX_PER_MESSAGE) return { error: `Attach up to ${MAX_PER_MESSAGE} files to one message` };
  const rows: AttachmentRow[] = [];
  for (const id of unique) {
    const row = db
      .prepare(
        `SELECT a.* FROM attachments a LEFT JOIN messages m ON m.id = a.message_id
         WHERE a.id = ? AND a.user_id = ? AND (a.message_id IS NULL OR m.conversation_id IS ?)`,
      )
      .get(id, userId, conversationId) as AttachmentRow | undefined;
    if (!row || !existsSync(row.path)) return { error: "One of the files isn't here any more. Remove it and add it again" };
    rows.push(row);
  }
  return rows;
}

/** "text files", "images and text files", "images, PDFs and text files". */
function kindsPhrase(kinds: AttachmentKind[]): string {
  const names = (["image", "pdf", "text"] as const).filter((k) => kinds.includes(k)).map((k) => ({ image: "images", pdf: "PDFs", text: "text files" })[k]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "no files");
}

/**
 * Whether the model running this message can take these files: each model opens some kinds
 * (DeepSeek text only, OpenAI and Gemini images and PDFs too), and files that aren't images, PDFs
 * or text need a Claude or OpenAI chat that can run code. Null when it can.
 */
export function unreadable(rows: Pick<AttachmentRow, "kind" | "name">[], key: KeyRow, modelName: string, codeTool: boolean): string | null {
  const reads = readsFor(key, codeTool);
  const unread = rows.filter((r) => !reads.includes(r.kind));
  if (!unread.length) return null;
  const other = unread.find((r) => r.kind === "other");
  if (other && hasTools(key.provider)) {
    return `${modelName} can open ${other.name} only in a chat where it can run code. Images, PDFs and text files up to ${mb(MAX_TEXT_BYTES)} work in any chat`;
  }
  return `${modelName} reads ${kindsPhrase(reads)} only. Pick another model to send ${unread.length === 1 ? unread[0].name : "these files"}`;
}

/** Ties the files to the message they were sent with. Files from another message are copied. */
export function attachTo(messageId: number, rows: AttachmentRow[]) {
  const link = db.prepare("UPDATE attachments SET message_id = ?, position = ? WHERE id = ? AND message_id IS NULL");
  const copy = db.prepare(
    `INSERT INTO attachments (id, user_id, message_id, name, mime, kind, size, sha256, path, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((r, i) => {
    if (r.message_id == null) link.run(messageId, i, r.id);
    else copy.run(randomBytes(12).toString("base64url"), r.user_id, messageId, r.name, r.mime, r.kind, r.size, r.sha256, r.path, i, nowIso());
  });
}

/** The account a key belongs to, as far as uploads go: the same secret shares its uploads. */
const accountOf = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex").slice(0, 32);

/** The type a file is uploaded as: text of any kind goes as plain text, which Claude reads as a document. */
function uploadType(a: HistoryAttachment): string {
  if (a.kind === "text") return "text/plain";
  return a.mime;
}

/**
 * Makes sure every file in the history is in this key's account (Claude or OpenAI), uploading the
 * ones that aren't yet, and returns their file ids (by fileRef). `onUploading` is called before the
 * first upload.
 */
export async function providerFileIds(
  provider: string,
  apiKey: string,
  history: HistoryTurn[],
  onUploading: () => void,
): Promise<Map<string, string>> {
  const account = accountOf(apiKey);
  const ids = new Map<string, string>();
  const known = db.prepare("SELECT file_id FROM provider_files WHERE account = ? AND sha256 = ? AND name = ?");
  const missing: HistoryAttachment[] = [];
  for (const turn of history) {
    for (const a of turn.attachments ?? []) {
      const ref = fileRef(a);
      if (ids.has(ref) || missing.some((m) => fileRef(m) === ref)) continue;
      const row = known.get(account, a.sha256, a.name) as { file_id: string } | undefined;
      if (row) ids.set(ref, row.file_id);
      else missing.push(a);
    }
  }
  if (!missing.length) return ids;

  onUploading();
  // OpenAI's files are for its sandbox; user_data is its purpose for files a model works with.
  const upload =
    provider === "openai"
      ? async (a: HistoryAttachment) => {
          const file = await toOpenAIFile(readFileSync(a.path), a.name, { type: uploadType(a) });
          return (await openaiClient(apiKey, OPENAI_API, 2).files.create({ file, purpose: "user_data" })).id;
        }
      : async (a: HistoryAttachment) => {
          const file = await toFile(readFileSync(a.path), a.name, { type: uploadType(a) });
          return (await anthropicClient(apiKey, 2).files.upload({ file })).id;
        };
  const save = db.prepare(
    `INSERT INTO provider_files (account, sha256, name, file_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account, sha256, name) DO UPDATE SET file_id = excluded.file_id, created_at = excluded.created_at`,
  );
  for (const a of missing) {
    const id = await upload(a);
    save.run(account, a.sha256, a.name, id, nowIso());
    ids.set(fileRef(a), id);
  }
  return ids;
}

/** Forgets this account's uploads of these files, so the next message uploads them again. */
export function forgetProviderFiles(apiKey: string, history: HistoryTurn[]) {
  const account = accountOf(apiKey);
  const forget = db.prepare("DELETE FROM provider_files WHERE account = ? AND sha256 = ? AND name = ?");
  for (const turn of history) for (const a of turn.attachments ?? []) forget.run(account, a.sha256, a.name);
}

/** Paths of every file in a chat, made or attached, so deleting the chat can remove them. */
export function pathsOfConversation(conversationId: string): string[] {
  return (
    db
      .prepare(
        `SELECT a.path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?
         UNION SELECT f.path FROM message_files f JOIN messages m ON m.id = f.message_id WHERE m.conversation_id = ?`,
      )
      .all(conversationId, conversationId) as { path: string }[]
  ).map((r) => r.path);
}
