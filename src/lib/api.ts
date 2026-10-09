// Thin client for the Hono API. Errors carry the server's sentence so the UI can show it as is.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new ApiError(res.status, data.error ?? "Something went wrong. Try again");
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
  /** Files the reply made (Claude's code execution), downloaded from /api/files/:id. */
  files?: { id: string; name: string; mime: string; size: number }[];
  createdAt: string;
};

/** About you, and how the AI should answer: Account defaults, or one chat's own. */
export type Instructions = { aboutMe: string; answerStyle: string };

/** A model a person can pick (each one is an admin's API key). */
export type ModelChoice = {
  keyId: number;
  model: string;
  label: string;
  /** Thinking levels this model takes, lowest first, and the one a chat starts on. */
  efforts: { id: string; label: string }[];
  defaultEffort: string;
};
/** One chat's pick: which key runs it, the model, and how hard it thinks. */
export type Choice = { keyId: number; model: string; effort: string };

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  shared?: boolean;
  /** A reply is being written for this chat right now. */
  generating?: boolean;
};

/** Who can open shared chat links, as an admin set it. */
export type SharingMode = "anyone" | "signed-in" | "off";
/** A chat's read-only link: it shows the chat up to message leafId, as of sharedAt. */
export type Share = { token: string; leafId: number; sharedAt: string };
export const shareUrl = (token: string) => `${window.location.origin}/share/${token}`;

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
  /** "searching" comes with the query. */
  onStatus: (status: "thinking" | "writing" | "searching" | "coding" | "saving", detail?: string) => void;
  onNotice: (message: string) => void;
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
    /** A new chat's own instructions (else it starts with the Account defaults). */
    instructions?: Instructions;
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
      else if (event === "done") handlers.onDone(payload.message);
      else if (event === "error") handlers.onError(payload.message);
      else if (event === "title") handlers.onTitle?.(payload.title);
    }
  }
}
