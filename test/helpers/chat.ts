// What the providers are handed, and files to attach, for tests that call a provider directly.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, HistoryAttachment, HistoryTurn } from "../../server/providers/types.ts";

/** What a provider passed back while it streamed. */
export type Seen = { text: string; thinking: string; statuses: string[]; notices: string[] };

/** A request for one reply, with callbacks that record what came back. */
export function chatRequest(overrides: Partial<ChatRequest> = {}): { req: ChatRequest; seen: Seen } {
  const seen: Seen = { text: "", thinking: "", statuses: [], notices: [] };
  const req: ChatRequest = {
    apiKey: "sk-test",
    model: "test-model",
    effort: "default",
    system: "Be brief.",
    history: [turn("user", "Hi")],
    reads: ["text"],
    signal: new AbortController().signal,
    showThinking: true,
    searchTool: false,
    searchAllowed: false,
    codeTool: false,
    codeAllowed: false,
    onText: (delta) => void (seen.text += delta),
    onThinking: (delta) => void (seen.thinking += delta),
    onStatus: (status) => void seen.statuses.push(status),
    onNotice: (message) => void seen.notices.push(message),
    ...overrides,
  };
  return { req, seen };
}

export const turn = (role: HistoryTurn["role"], text: string, attachments?: HistoryAttachment[]): HistoryTurn => ({
  role,
  text,
  content: null,
  provider: null,
  ...(attachments ? { attachments } : {}),
});

/** A folder of files to attach, removed with `remove()`. */
export function fileFolder() {
  const dir = mkdtempSync(join(tmpdir(), "parley-files-"));
  return {
    dir,
    /** A file on disk as a message's attachment. */
    add(name: string, kind: HistoryAttachment["kind"], mime: string, bytes: string | Buffer): HistoryAttachment {
      const path = join(dir, `${Math.random().toString(36).slice(2)}-${name.replace(/[^\w.-]/g, "_")}`);
      writeFileSync(path, bytes);
      const data = Buffer.from(bytes);
      return { name, kind, mime, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), path };
    },
    /** An attachment whose bytes are gone from the disk. */
    missing(name: string, kind: HistoryAttachment["kind"], mime: string): HistoryAttachment {
      return { name, kind, mime, size: 1, sha256: "0".repeat(64), path: join(dir, "gone", name) };
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The smallest PNG there is: one transparent pixel. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
