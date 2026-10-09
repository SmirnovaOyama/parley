import type { FileKind, Usage } from "./catalog.ts";

/** One stored turn, as the providers need it to rebuild the conversation. */
export type HistoryTurn = {
  /** "system": a note from the app mid-chat, such as changed chat instructions. */
  role: "user" | "assistant" | "system";
  text: string;
  /** Provider-native content (Claude content blocks) for assistant turns, when we have it. */
  content: unknown;
  provider: string | null;
  /** On a user turn: the files attached to it, in order. */
  attachments?: HistoryAttachment[];
};

/** One file's identity for uploads: its bytes and its name (code sees files by name). */
export const fileRef = (a: Pick<HistoryAttachment, "sha256" | "name">) => `${a.sha256}:${a.name}`;

/**
 * The line that goes just ahead of a picture. Documents carry their names, but an image part has
 * nowhere to put one, so without this a model can't tell which picture is which file.
 */
export const imageCaption = (a: Pick<HistoryAttachment, "name">) => `Image: ${a.name}`;

/** A file on a user turn: what it is, and where its bytes are kept. */
export type HistoryAttachment = {
  name: string;
  mime: string;
  kind: "image" | "pdf" | "text" | "other";
  size: number;
  sha256: string;
  path: string;
};

export type ChatRequest = {
  apiKey: string;
  /** A key on an OpenAI-compatible service of the admin's choosing: where that service is. */
  baseUrl?: string;
  model: string;
  effort: string;
  system: string;
  history: HistoryTurn[];
  /** The kinds of attached file this model opens itself; others are named in the message instead. */
  reads: FileKind[];
  /** Stays the same for one chat, so services that route by it (OpenAI, xAI) find its cached prefix. */
  cacheKey?: string;
  signal: AbortSignal;
  onText: (delta: string) => void;
  /** Visible thinking as it arrives; only called when `showThinking` is on. */
  onThinking: (delta: string) => void;
  showThinking: boolean;
  /** Claude, OpenAI: this chat declares web search. Fixed for the life of a chat (see db.ts). */
  searchTool: boolean;
  /** Claude, OpenAI: let it search now (the key's switch). Claude off with the tool declared means tool_choice "none". */
  searchAllowed: boolean;
  /** Claude, OpenAI: this chat declares running code (it makes files). Fixed for the life of a chat, like search. */
  codeTool: boolean;
  /** Claude, OpenAI: let it run code now (the key's switch). */
  codeAllowed: boolean;
  /** Claude, OpenAI: the sandbox this chat's code ran in before, to carry on in (same key, not expired). */
  container?: string | null;
  /**
   * Each attached file's id in this key's account, by fileRef (see attachments.ts). Claude reads
   * every file this way; OpenAI only gets them in chats that run code, to put in the sandbox.
   */
  fileIds?: Map<string, string>;
  /** "searching" comes with the query; "coding" while it runs code. */
  onStatus: (status: "thinking" | "writing" | "searching" | "coding", detail?: string) => void;
  onNotice: (message: string) => void;
};

/** A web page a reply cited, numbered in the order first cited. */
export type Source = { url: string; title: string };

export type ChatResult = {
  text: string;
  /** The visible thinking, if any was shown. */
  thinking: string;
  /** What to store and send back next turn (Claude content blocks), or null to fall back to text. */
  content: unknown;
  model: string;
  stopReason: string;
  refused: boolean;
  usage: Usage;
  /** What it searched the web for, and the pages it cited (the text carries [n](url) markers). */
  searches: string[];
  sources: Source[];
  /** Pages its searches returned. Claude filtering results in code often cites none; then these show. */
  found: Source[];
  /** Files its code made, as provider file ids to fetch and keep (OpenAI's as "container_id/file_id"). */
  fileIds: string[];
  /** The sandbox its code ran in, to reuse for the chat's next message. */
  container: { id: string; expiresAt: string } | null;
};

/** A short one-off request (naming a chat), answered in full rather than streamed. */
export type CompleteRequest = { apiKey: string; baseUrl?: string; model: string; system: string; prompt: string; signal?: AbortSignal };
export type CompleteResult = { text: string; model: string; usage: Usage } | null;

export type ChatProvider = {
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Null when the model declined. */
  complete(req: CompleteRequest): Promise<CompleteResult>;
  /** Throws when the key can't reach the model. */
  verify(apiKey: string, model: string, baseUrl?: string): Promise<void>;
};
