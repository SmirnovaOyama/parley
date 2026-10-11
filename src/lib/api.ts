// Thin client for the Hono API. Errors carry the server's sentence so the UI can show it as is.

export class ApiError extends Error {
  status: number;
  /** The form field the problem is with, where the server says (like "code"). */
  field: string | null;
  constructor(status: number, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "Something went wrong. Try again", typeof data.field === "string" ? data.field : null);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ── Shared shapes ───────────────────────────────────────────────────

export type User = { id: number; email: string; role: "admin" | "user" };

export type MessageStatus = "ok" | "truncated" | "stopped" | "declined" | "failed" | "not-sent";

export type Message = {
  id: number;
  /** The message this one follows in the conversation tree (null for the first). */
  parentId: number | null;
  role: "user" | "assistant";
  text: string;
  model: string;
  status: MessageStatus;
  error: string | null;
  /** A quiet line under the reply, e.g. that a backup model answered it. */
  note: string | null;
  /** What the model showed of its thinking, and how long it thought for. */
  thinking: string | null;
  thinkingMs: number | null;
  /** On your message: the chat's instructions changed from here on. */
  instructionsChanged: boolean;
  /** Every version of this message (itself included), oldest first. */
  siblingIds: number[];
  /** What the reply searched the web for, and the pages its [n] markers point to. */
  searches?: string[];
  sources?: { url: string; title: string }[];
  /** When it cited nothing: pages its searches returned. */
  found?: { url: string; title: string }[];
  /** Files the reply made (Claude's or OpenAI's code), downloaded from /api/files/:id. */
  files?: { id: string; name: string; mime: string; size: number }[];
  /** On your message: the files you attached, from /api/files/:id too. */
  attachments?: Attachment[];
  /** On a reply: what it did with the app's tools, in words ("Remembered “…”", "Used create_issue on GitHub"). */
  tools?: ToolUse[];
  /** On a reply: how much of the model's context the chat filled by its end, in tokens. */
  contextTokens?: number | null;
  createdAt: string;
};

export type ToolUse = {
  kind: "memory" | "knowledge" | "page" | "mcp";
  text: string;
  error?: boolean;
  /** An MCP tool that didn't run for want of your own account on its server: the line links to Connected services. */
  connect?: boolean;
};

/**
 * An MCP server that acts with each person's own account, as Settings › Connected services shows
 * it: signed in on its own page (oauth) or with a pasted token, and where you stand with it.
 */
export type Connection = {
  id: number;
  name: string;
  mode: "oauth" | "token";
  /** Where the server is, so you know whose sign-in page to expect. */
  host: string;
  /** What your admins say to paste, for a server on pasted tokens. */
  hint: string;
  status: "connected" | "missing" | "expired";
  connectedAt: string | null;
  usedAt: string | null;
};

/**
 * A question a reply is waiting on before one of its tools runs (reading a page nobody linked,
 * keeping a note, an MCP tool that may change things), answered on a line in the reply.
 */
export type Ask = { id: string; kind: "page" | "memory" | "mcp"; question: string; detail: string; reason: string };

/** A file attached to a message: what the model gets is its kind (other: only code can open it). */
export type Attachment = { id: string; name: string; mime: string; size: number; kind: "image" | "pdf" | "text" | "other" };

/** About you, and how the AI should answer: a persona's, or one chat's own. */
export type Instructions = { aboutMe: string; answerStyle: string };

/** One of up to five ways a person presents themselves to the AI. */
export type Persona = Instructions & { id: string; name: string; /** New chats start as this one. */ forNewChats: boolean };

/** A model a person can pick (each one is an admin's API key). */
export type ModelChoice = {
  keyId: number;
  model: string;
  label: string;
  /** Thinking levels this model takes, lowest first, and the one a chat starts on. */
  efforts: { id: string; label: string }[];
  defaultEffort: string;
  /** The kinds of file it can open: some of images, PDFs and text, or anything (Claude or OpenAI running code). */
  reads: Attachment["kind"][];
  /** Tokens it reads at once; null where it isn't known. */
  context: number | null;
};
/** One chat's pick: which key runs it, the model, and how hard it thinks. */
export type Choice = { keyId: number; model: string; effort: string };

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  /** The project it's in, and when it was pinned to the top (null when it isn't). */
  projectId?: string | null;
  pinnedAt?: string | null;
  shared?: boolean;
  /** A reply is being written for this chat right now. */
  generating?: boolean;
};

/** One of your chats found by a search, with a line of the newest message that matched (null when only its title did). */
export type ChatHit = {
  id: string;
  title: string;
  updatedAt: string;
  projectId: string | null;
  snippet: string | null;
};

/** A project: a folder of chats with its own instructions and knowledge bases. */
export type Project = { id: string; name: string; instructions: string; knowledgeIds: string[]; chats: number; updatedAt: string };

/** A knowledge base: documents chats can search. Yours, or an admin's shared with everyone. */
export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  shared: boolean;
  mine: boolean;
  canEdit: boolean;
  /** Who made it, when it isn't you. */
  owner: string | null;
  docs: number;
  bytes: number;
  updatedAt: string;
};
export type KnowledgeDoc = { id: string; name: string; mime: string; size: number; chars: number; parts: number; createdAt: string };

/** The site's rules that touch a person's data. */
export type Policy = { retainChatsDays: number | null; retainDeletedDays: number | null; memory: boolean; privacyNotice: boolean };

/** A device someone is signed in on (server/sessions.ts). */
export type Device = {
  id: string;
  /** What it's used in: "Chrome on macOS", or the program when it isn't a browser ("curl"). */
  device: string;
  browser: boolean;
  /** The network address it was last used from. */
  address: string | null;
  signedInAt: string;
  /** Null for a sign-in from before these were noted that hasn't been used since. */
  lastSeenAt: string | null;
  /** The device asking. */
  current: boolean;
};

/** Who can open shared chat links, as an admin set it. */
export type SharingMode = "anyone" | "signed-in" | "off";
/** A chat's read-only link: it shows the chat up to message leafId, as of sharedAt. */
export type Share = { token: string; leafId: number; sharedAt: string };
export const shareUrl = (token: string) => `${window.location.origin}/share/${token}`;

// ── Attaching files ─────────────────────────────────────────────────

/**
 * Uploads one file for the message being written, reporting how much of it has gone. Uses
 * XMLHttpRequest because fetch can't report upload progress. abort() stops it.
 */
export function uploadFile(file: Blob, name: string, onProgress: (fraction: number) => void) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open("PUT", "/api/uploads");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { attachment?: Attachment; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: a proxy's error page, say.
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.attachment) resolve(data.attachment);
      else reject(new ApiError(xhr.status, data.error ?? "Couldn't add this file. Try again"));
    };
    xhr.onerror = () => reject(new ApiError(0, "Couldn't add this file. Check the connection and try again"));
    xhr.onabort = () => reject(new ApiError(0, "Stopped"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/**
 * Sends a file's bytes to an endpoint that takes them raw (a knowledge base's documents, an
 * import), reporting progress. Resolves with the JSON the server answered.
 */
export function uploadRaw<T>(path: string, file: Blob, name: string, onProgress?: (fraction: number) => void) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open("PUT", `/api${path}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: a proxy's error page, say.
      }
      if (xhr.status >= 200 && xhr.status < 300 && !data.error) resolve(data as T);
      else reject(new ApiError(xhr.status, data.error ?? "Couldn't send this file. Try again"));
    };
    xhr.onerror = () => reject(new ApiError(0, "Couldn't send this file. Check the connection and try again"));
    xhr.onabort = () => reject(new ApiError(0, "Stopped"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

// ── Streaming a reply ───────────────────────────────────────────────

export type StreamHandlers = {
  onMeta: (meta: {
    conversationId: string;
    title: string;
    created: boolean;
    userMessageId: number;
    keyId: number;
    /** The model's name, and its id and thinking level as this reply runs them. */
    model: string;
    modelId: string;
    effort: string;
  }) => void;
  onDelta: (text: string) => void;
  onThinking: (text: string) => void;
  /** "searching" comes with the query; "tool" with a few words on what it's doing ("Updating memory"). */
  onStatus: (status: "thinking" | "writing" | "searching" | "coding" | "saving" | "uploading" | "tool", detail?: string) => void;
  onNotice: (message: string) => void;
  /** The questions the reply is waiting on now (none once they're answered). */
  onAsks?: (asks: Ask[]) => void;
  onDone: (message: Message) => void;
  onError: (message: Message) => void;
  /** The chat got a new title, written after the reply. */
  onTitle?: (title: string) => void;
};

/**
 * Sends a message and reads the server-sent events of the reply. Resolves when the stream ends.
 * Aborting the signal only stops listening; the server keeps writing and saves the reply.
 */
export async function streamChat(
  body: {
    conversationId: string | null;
    /** The chat's pick; left out, the server uses what the chat ran on last, or the person's start. */
    keyId?: number;
    model?: string;
    effort?: string;
    text?: string;
    /** Edit: the new version follows this message (null for the first message). */
    parentId?: number | null;
    /** Regenerate: a new reply to this user message. */
    regenerate?: number;
    /** A new chat's own instructions (else it starts with the defaults in Settings). */
    instructions?: Instructions;
    /** A new chat's project, and the knowledge bases picked for it. */
    projectId?: string;
    knowledgeIds?: string[];
    /** Files for the new message or the edited version (uploaded first, see uploadFile). */
    attachments?: string[];
  },
  handlers: StreamHandlers,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? "Couldn't send the message. Try again");
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === "meta") handlers.onMeta(payload);
      else if (event === "delta") handlers.onDelta(payload.text);
      else if (event === "thinking") handlers.onThinking(payload.text);
      else if (event === "status") handlers.onStatus(payload.status, payload.detail);
      else if (event === "notice") handlers.onNotice(payload.message);
      else if (event === "asks") handlers.onAsks?.(payload.asks);
      else if (event === "done") handlers.onDone(payload.message);
      else if (event === "error") handlers.onError(payload.message);
      else if (event === "title") handlers.onTitle?.(payload.title);
    }
  }
}
