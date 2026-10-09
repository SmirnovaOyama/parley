import type { Usage } from "./catalog.ts";

/** One stored turn, as the providers need it to rebuild the conversation. */
export type HistoryTurn = {
  /** "system": a note from the app mid-chat, such as changed chat instructions. */
  role: "user" | "assistant" | "system";
  text: string;
  /** Provider-native content (Claude content blocks) for assistant turns, when we have it. */
  content: unknown;
  provider: string | null;
};

export type ChatRequest = {
  apiKey: string;
  model: string;
  effort: string;
  system: string;
  history: HistoryTurn[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  /** Visible thinking as it arrives; only called when `showThinking` is on. */
  onThinking: (delta: string) => void;
  showThinking: boolean;
  /** Claude: declare the web search tool. Fixed for the life of a chat (see db.ts). */
  searchTool: boolean;
  /** Claude: let it search now (the key's switch). Off with the tool declared means tool_choice "none". */
  searchAllowed: boolean;
  /** Claude: declare the code execution tool (it makes files). Fixed for the life of a chat, like search. */
  codeTool: boolean;
  /** Claude: let it run code now (the key's switch). */
  codeAllowed: boolean;
  /** Claude: the sandbox this chat's code ran in before, to carry on in (same key, not expired). */
  container?: string | null;
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
  /** Files its code made, as provider file ids to fetch and keep. */
  fileIds: string[];
  /** The sandbox its code ran in, to reuse for the chat's next message. */
  container: { id: string; expiresAt: string } | null;
};

/** A short one-off request (naming a chat), answered in full rather than streamed. */
export type CompleteRequest = { apiKey: string; model: string; system: string; prompt: string; signal?: AbortSignal };
export type CompleteResult = { text: string; model: string; usage: Usage } | null;

export type ChatProvider = {
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Null when the model declined. */
  complete(req: CompleteRequest): Promise<CompleteResult>;
  /** Throws when the key can't reach the model. */
  verify(apiKey: string, model: string): Promise<void>;
};
