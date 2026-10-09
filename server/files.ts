// Files a reply made with Claude's code execution or OpenAI's code interpreter. They live in the
// provider's account only for a while, and only that key can read them, so each one is copied here
// when the reply is saved: next to the database (never inside the repository), under a random name,
// one folder per chat.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { PublicFile } from "./chat-store.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";

export const FILES_DIR = join(dirname(env.databasePath), "files");

/** At most this many files are kept from one reply, and each up to this size. */
const MAX_FILES = 20;
const MAX_BYTES = 50 * 1024 * 1024;

/** A name that's safe to save and to offer back: no folders, no control characters, a sane length. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]+/g, "").trim();
  if (!base || base === "." || base === "..") return "file";
  if (base.length <= 120) return base;
  const ext = extname(base).slice(0, 12);
  return base.slice(0, 120 - ext.length) + ext;
}

/** A made file as fetched: its name, its type, and its bytes. Null when it's too big to keep. */
type Fetched = { name: string; mime: string; bytes: Buffer } | null;

/** Claude's Files API: the name and type come with the file. */
function fromClaude(apiKey: string): (fileId: string) => Promise<Fetched> {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return async (fileId) => {
    const meta = await client.files.retrieveMetadata(fileId);
    if (meta.size_bytes > MAX_BYTES) return null;
    const bytes = Buffer.from(await (await client.files.download(fileId)).arrayBuffer());
    return { name: meta.filename, mime: meta.mime_type || "application/octet-stream", bytes };
  };
}

/** Types of the files code usually makes, by extension: OpenAI's sandbox doesn't say. */
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".html": "text/html",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

/** OpenAI's sandbox, a file at a time ("container_id/file_id"): named after its path there. */
function fromOpenAI(apiKey: string): (ref: string) => Promise<Fetched> {
  const client = new OpenAI({ apiKey, maxRetries: 2 });
  return async (ref) => {
    const [container_id, fileId] = ref.split("/");
    const meta = await client.containers.files.retrieve(fileId, { container_id });
    if (meta.bytes > MAX_BYTES) return null;
    const bytes = Buffer.from(await (await client.containers.files.content.retrieve(fileId, { container_id })).arrayBuffer());
    const name = basename(meta.path);
    return { name, mime: TYPES[extname(name).toLowerCase()] ?? "application/octet-stream", bytes };
  };
}

/**
 * Copies the reply's files from the provider and records them on the message. A file that can't
 * be fetched is skipped (the reply still stands); the count of those comes back for a note.
 */
export async function keepFiles(
  provider: string,
  apiKey: string,
  fileIds: string[],
  messageId: number,
  conversationId: string,
): Promise<{ files: PublicFile[]; failed: number }> {
  const fetchFile = provider === "openai" ? fromOpenAI(apiKey) : fromClaude(apiKey);
  const folder = join(FILES_DIR, conversationId);
  const files: PublicFile[] = [];
  let failed = 0;
  for (const fileId of fileIds.slice(0, MAX_FILES)) {
    try {
      const fetched = await fetchFile(fileId);
      if (!fetched) {
        failed++;
        continue;
      }
      const { bytes, mime } = fetched;
      const id = randomBytes(12).toString("base64url");
      const name = safeName(fetched.name);
      mkdirSync(folder, { recursive: true });
      const path = join(folder, `${id}${extname(name).slice(0, 12)}`);
      writeFileSync(path, bytes);
      db.prepare(
        "INSERT INTO message_files (id, message_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, messageId, name, mime, bytes.length, path, nowIso());
      files.push({ id, name, mime, size: bytes.length });
    } catch (err) {
      console.error(`[files] couldn't keep ${fileId}:`, err);
      failed++;
    }
  }
  return { files, failed };
}

/**
 * A kept file: one a reply made, or one a person attached (message_id is null until it's sent).
 * owner_id is whose chat it's in, or who uploaded it.
 */
export type StoredFile = { id: string; message_id: number | null; owner_id: number; name: string; mime: string; size: number; path: string };

export function storedFile(id: string): StoredFile | undefined {
  return db
    .prepare(
      `SELECT f.id, f.message_id, cv.user_id AS owner_id, f.name, f.mime, f.size, f.path
       FROM message_files f JOIN messages m ON m.id = f.message_id JOIN conversations cv ON cv.id = m.conversation_id
       WHERE f.id = ?
       UNION ALL
       SELECT a.id, a.message_id, a.user_id, a.name, a.mime, a.size, a.path FROM attachments a WHERE a.id = ?`,
    )
    .get(id, id) as StoredFile | undefined;
}

/** Raster images open in the page (previews); everything else downloads. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Headers for sending a kept file. Only raster images may open inline; everything else downloads,
 * and server/index.ts sandboxes the response so nothing in it runs as this site.
 */
export function fileHeaders(file: StoredFile, inline: boolean): Record<string, string> {
  const showInline = inline && INLINE_TYPES.has(file.mime);
  const ascii = file.name.replace(/[^\x20-\x7e]+/g, "").replace(/"/g, "") || "file";
  return {
    "Content-Type": showInline ? file.mime : file.mime.startsWith("text/") ? "text/plain; charset=utf-8" : "application/octet-stream",
    "Content-Disposition": `${showInline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "Cache-Control": "private, max-age=3600",
  };
}
