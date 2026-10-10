// The Responses API, OpenAI's own and the one xAI follows: it returns summaries of the model's
// reasoning, and (at OpenAI) reads PDFs. Nothing is stored at the provider (store: false); the
// conversation goes back as plain text each time. At OpenAI it can also search the web and run code
// to make files, with OpenAI's own tools (see toolsFor).
import { existsSync } from "node:fs";
import { basename } from "node:path";
import OpenAI from "openai";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInputContent,
  ResponseInputItem,
  ResponseUsage,
  Tool,
} from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";
import { findModel, type ProviderId, type Usage } from "./catalog.ts";
import { base64Of, fileNote, fileText } from "./compat.ts";
import {
  fileRef,
  imageCaption,
  MAX_TOOL_ROUNDS,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type CompleteRequest,
  type CompleteResult,
  type HistoryAttachment,
  type HistoryTurn,
  type Source,
  type ToolCall,
} from "./types.ts";

type Options = {
  provider: ProviderId;
  /** Where the API is; OpenAI's own when left out. */
  baseURL?: string;
  /** Whether PDFs can go in as file data. */
  pdf: boolean;
  /** The picture formats it takes, where it doesn't take every one people can attach. */
  imageTypes?: string[];
  /** The role an app note mid-chat goes in as. */
  noteRole: "developer" | "system";
  /** Whether this model returns summaries of its reasoning. */
  summaries: (model: string) => boolean;
  /** OpenAI: it searches the web and runs code with OpenAI's tools, where the chat and key allow. */
  tools?: boolean;
};

/** The longest reply asked for, reasoning included. */
const MAX_OUTPUT = 64000;

/** "off" is the API's "none"; the other levels share their names. */
const effortOf = (effort: string) => (effort === "off" ? "none" : effort) as ReasoningEffort;

/**
 * Output includes the reasoning at OpenAI; where a service counts reasoning apart, it shows in the
 * total, so whichever is larger is what was written.
 */
function usageOf(u: ResponseUsage | null | undefined): Usage {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: Math.max(0, u.input_tokens - cacheRead - cacheWrite),
    output: Math.max(u.output_tokens, (u.total_tokens ?? 0) - u.input_tokens),
    cacheRead,
    cacheWrite,
  };
}

/** A function call's arguments, as an object even when the model wrote something else. */
export function parseArguments(json: string | null | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(json || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** A failure reported inside the stream, with the HTTP status it would have had. */
function streamError(code: string | null | undefined, message: string | null | undefined): Error {
  const status = code === "rate_limit_exceeded" ? 429 : code === "invalid_prompt" ? 400 : 500;
  return Object.assign(new Error(message || "The response failed"), { status });
}

/**
 * Reasoning summaries can need an organisation that's verified with the provider. A request turned
 * down for that goes again without them.
 */
const summariesRefused = (err: unknown) =>
  (err as { status?: number })?.status === 400 && /summar|verif/i.test((err as Error).message ?? "");

/** Pages kept from search results, for a reply that cites none (as with Claude). */
const MAX_FOUND = 10;
/** The most text held back while it may still turn out to be a citation. */
const MAX_HELD = 1000;
/** OpenAI ends a sandbox after 20 minutes unused. */
const SANDBOX_IDLE_MS = 20 * 60_000;
/** A link to a file in the sandbox, which has no address here: the files show as cards under the reply. */
const SANDBOX_LINK = /!?\[([^\]\n]*)\]\(sandbox:[^)\s]*\)/g;

/** OpenAI tags the pages it links with ?utm_source=openai; the address is kept without it. */
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.get("utm_source") !== "openai") return url;
    u.searchParams.delete("utm_source");
    return u.toString();
  } catch {
    return url;
  }
}

/** A Markdown link to this page, "[title](url)", maybe in brackets: what a citation looks like in the text. */
const isLink = (text: string, url: string) => text.includes(url) && /^\(?\[[^\]]*\]\(\S+\)\)?$/.test(text);

/**
 * Where a citation's link sits in its part's text, brackets around it included (`close`: the ")"
 * hasn't arrived yet). OpenAI may count characters where JavaScript counts UTF-16 units (they
 * differ after an emoji), so both readings are checked against the link.
 */
function spanOf(raw: string, start: number, end: number, url: string): { start: number; end: number; close: boolean } | null {
  const chars = Array.from(raw);
  for (const [s, e] of [[start, end], [chars.slice(0, start).join("").length, chars.slice(0, end).join("").length]]) {
    if (!isLink(raw.slice(s, e), url)) continue;
    if (raw[s] === "(" || raw[s - 1] !== "(") return { start: s, end: e, close: false };
    if (raw[e] === ")") return { start: s - 1, end: e + 1, close: false };
    if (e === raw.length) return { start: s - 1, end: e, close: true };
    return { start: s, end: e, close: false };
  }
  return null;
}

/**
 * How far a part's text can go out now: up to a link or bracket still open on its last line, which
 * may be a citation still arriving, and the spaces before that, which a citation's marker drops.
 */
function safeEnd(raw: string, from: number): number {
  // Where each open bracket's text starts: a link's "(" belongs with its "[title]", and an image's "[" with its "!".
  const open: number[] = [];
  let label = { start: -1, end: -1 };
  for (let i = from; i < raw.length; i++) {
    // A link never runs past the end of a line.
    if (raw[i] === "\n") {
      open.length = 0;
      label = { start: -1, end: -1 };
    } else if (raw[i] === "[") open.push(raw[i - 1] === "!" && i - 1 >= from ? i - 1 : i);
    else if (raw[i] === "(") open.push(label.end === i - 1 ? label.start : i);
    else if ((raw[i] === ")" || raw[i] === "]") && open.length) {
      const start = open.pop()!;
      if (raw[i] === "]") label = { start, end: i };
    }
  }
  // A "[title]" just closed may be a link whose "(" comes next, and a "!" an image's link.
  let end = Math.min(open.length ? open[0] : raw.length, label.end === raw.length - 1 ? label.start : raw.length);
  if (end === raw.length && raw.endsWith("!")) end--;
  if (raw.length - end > MAX_HELD) end = raw.length;
  while (end > from && (raw[end - 1] === " " || raw[end - 1] === "\t")) end--;
  return end;
}

/**
 * Streams a reply's words with its citations written the way Claude's are. OpenAI puts a citation
 * in the text as a Markdown link, "… blue ([example.com](https://…))", then names its span in an
 * annotation straight after. So text goes out one event late, and a link still open waits for the
 * rest of it. Once its annotation comes, the link becomes a numbered marker after the cited words,
 * "… blue[1](https://…)", and its page joins the sources.
 */
function citingWriter(onText: (delta: string) => void) {
  const sources: Source[] = [];
  let text = "";
  /** The text part being written (item id and content index), its text as OpenAI wrote it, and how much of that is dealt with. */
  let part = "";
  let raw = "";
  let sent = 0;
  /** Where the ")" closing a replaced citation's brackets is due, when it hadn't come with the link. */
  let close = -1;
  /** A round of tools just ended: the next words start a new paragraph. */
  let gap = false;
  const out = (chunk: string) => {
    let words = chunk.replace(SANDBOX_LINK, "$1");
    if (gap && text && words.trim()) {
      words = `\n\n${words.trimStart()}`;
      gap = false;
    }
    if (!words) return;
    text += words;
    onText(words);
  };
  const sendTo = (end: number) => {
    if (close === sent && sent < raw.length) {
      if (raw[sent] === ")") sent++;
      close = -1;
    }
    if (end <= sent) return;
    out(raw.slice(sent, end));
    sent = end;
  };
  return {
    get text() {
      return text;
    },
    sources,
    /** More of a part's text: what came before it goes out, as far as it safely can. */
    delta(key: string, delta: string) {
      if (key !== part) {
        sendTo(raw.length);
        part = key;
        raw = "";
        sent = 0;
        close = -1;
      }
      sendTo(safeEnd(raw, sent));
      raw += delta;
    },
    cite(key: string, start: number, end: number, url: string, title: string) {
      const page = cleanUrl(url);
      let n = sources.findIndex((s) => s.url === page) + 1;
      if (!n) n = sources.push({ url: page, title });
      if (key === part) {
        let span = spanOf(raw, start, end, url);
        if (!span && start === end && start >= sent && start <= raw.length) span = { start, end, close: false };
        if (span && span.start >= sent) {
          out(raw.slice(sent, span.start).replace(/[ \t]+$/, ""));
          sent = span.end;
          if (span.close) close = sent;
        } else {
          // Already partly out (or not found): the marker follows the link.
          sendTo(Math.max(sent, span?.end ?? raw.length));
        }
      }
      // The same page cited twice running shows once.
      const mark = `[${n}](${page})`;
      if (!text.endsWith(mark)) {
        text += mark;
        onText(mark);
      }
    },
    /** Something other than text came: all of it goes out. */
    flush() {
      sendTo(raw.length);
    },
    /** The model went off to use tools: what it writes next is a new paragraph. */
    pause() {
      sendTo(raw.length);
      gap = true;
    },
  };
}

export function responsesProvider(options: Options): ChatProvider {
  const client = (apiKey: string, maxRetries: number) => new OpenAI({ apiKey, baseURL: options.baseURL, maxRetries });

  /** Whether a file goes in as a part of its own: an image in a format it takes, or a PDF where it reads them. */
  const asPart = (file: HistoryAttachment, reads: string[]) =>
    reads.includes(file.kind) &&
    ((file.kind === "image" && (!options.imageTypes || options.imageTypes.includes(file.mime))) || (file.kind === "pdf" && options.pdf));

  /**
   * A message's files ahead of its words: images and PDFs as parts, text files inline. In a chat
   * running code, a line says which of them code can open in the sandbox (anything else only there).
   */
  function userContent(turn: HistoryTurn, reads: string[], boxed: (file: HistoryAttachment) => boolean): string | ResponseInputContent[] {
    const parts: ResponseInputContent[] = [];
    const text: string[] = [];
    const inSandbox: string[] = [];
    for (const file of turn.attachments ?? []) {
      if (boxed(file)) inSandbox.push(file.name);
      if (file.kind === "text" && reads.includes("text")) {
        text.push(existsSync(file.path) ? fileText(file) : fileNote(file, false));
        continue;
      }
      if (!asPart(file, reads)) {
        if (!boxed(file)) text.push(fileNote(file, true));
        continue;
      }
      const data = base64Of(file);
      if (!data) text.push(fileNote(file, false));
      else if (file.kind === "image") {
        parts.push({ type: "input_text", text: imageCaption(file) }, { type: "input_image", image_url: `data:${file.mime};base64,${data}`, detail: "auto" });
      }
      else parts.push({ type: "input_file", filename: file.name, file_data: `data:application/pdf;base64,${data}` });
    }
    if (inSandbox.length) text.push(`(Code can open these files in the sandbox: ${inSandbox.join(", ")}.)`);
    const words = [...text, turn.text].filter(Boolean).join("\n\n");
    if (!parts.length) return words;
    return words ? [...parts, { type: "input_text", text: words }] : parts;
  }

  function toInput(req: ChatRequest, boxed: (file: HistoryAttachment) => boolean): ResponseInputItem[] {
    return req.history.map((turn): ResponseInputItem => {
      if (turn.role === "user") return { role: "user", content: userContent(turn, req.reads, boxed) };
      if (turn.role === "assistant") return { role: "assistant", content: turn.text };
      // Mid-chat notes from the app (changed instructions, search off).
      return { role: options.noteRole, content: turn.text };
    });
  }

  /**
   * The tools this reply may use: OpenAI's web search and code interpreter, each where the chat
   * declares it and this key's switch is on. Claude's chats send the same tool list every time
   * because Claude ties its reasoning to it; here the history goes back as plain text, with no
   * reasoning in it, so a tool that can't be used now is simply left out. The rule for using one is
   * still Claude's: declared when the chat started (while some key had it on), then allowed by the
   * key that answers. So a chat that moves between Claude and GPT gives one answer to "can it search".
   */
  async function toolsFor(api: OpenAI, req: ChatRequest): Promise<Tool[]> {
    const tools: Tool[] = [];
    if (!options.tools) return tools;
    // Without a location OpenAI searches as if from the United States.
    if (req.searchTool && req.searchAllowed) tools.push({ type: "web_search", user_location: { type: "approximate" } });
    if (req.codeTool && req.codeAllowed) tools.push({ type: "code_interpreter", container: await sandbox(api, req) });
    return tools;
  }

  /**
   * The sandbox this reply's code runs in: the chat's own while it lasts, given any attached files
   * it lacks, so its earlier work is still there; else a new one with every file attached so far.
   */
  async function sandbox(api: OpenAI, req: ChatRequest): Promise<Tool.CodeInterpreter["container"]> {
    const files = new Map<string, { name: string; id: string }>();
    for (const turn of req.history) {
      for (const a of turn.attachments ?? []) {
        const id = req.fileIds?.get(fileRef(a));
        if (id) files.set(fileRef(a), { name: a.name, id });
      }
    }
    const there = req.container ? await sandboxFiles(api, req.container, req.signal) : null;
    if (req.container && there) {
      // A file the account lost fails here, and the chat uploads it again (see routes/chat.ts).
      for (const f of files.values()) {
        if (there.has(f.name)) continue;
        await api.containers.files.create(req.container, { file_id: f.id }, { signal: req.signal });
        there.add(f.name);
      }
      return req.container;
    }
    const ids = [...new Set([...files.values()].map((f) => f.id))];
    return { type: "auto", memory_limit: "1g", ...(ids.length ? { file_ids: ids } : {}) };
  }

  /** The names of the files in a sandbox, or null when it's gone already (expired, or deleted at OpenAI). */
  async function sandboxFiles(api: OpenAI, container: string, signal: AbortSignal): Promise<Set<string> | null> {
    const names = new Set<string>();
    try {
      for await (const f of api.containers.files.list(container, undefined, { signal })) names.add(basename(f.path));
    } catch (err) {
      if ([400, 404, 410].includes((err as { status?: number })?.status ?? 0)) return null;
      throw err;
    }
    return names;
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const effort = effortOf(req.effort);
    // Summaries cost nothing extra; they're asked for only when the site shows them.
    const summary = req.showThinking && effort !== "none" && options.summaries(req.model);
    const api = client(req.apiKey, 2);
    // The provider's own tools, then the app's as functions.
    let tools: Tool[] = [
      ...(await toolsFor(api, req)),
      ...req.functions.map((f): Tool => ({ type: "function", name: f.name, description: f.description, parameters: f.parameters, strict: false })),
    ];
    const own = new Set(req.functions.map((f) => f.name));
    const searching = tools.some((t) => t.type === "web_search");
    const coding = tools.some((t) => t.type === "code_interpreter");
    const boxed = (file: HistoryAttachment) => coding && !!req.fileIds?.has(fileRef(file));
    // What the model reads: the chat, then this reply's own tool calls and their results as it goes.
    let input: ResponseInputItem[] = toInput(req, boxed);
    const params = (withSummary: boolean, lastRound: boolean): ResponseCreateParamsStreaming => ({
      model: req.model,
      instructions: req.system,
      input,
      reasoning: { effort, ...(withSummary ? { summary: "auto" as const } : {}) },
      max_output_tokens: MAX_OUTPUT,
      store: false,
      stream: true,
      ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
      ...(tools.length ? { tools, ...(lastRound && own.size ? { tool_choice: "none" as const } : {}) } : {}),
      // Every page a search looked at, shown when the reply cites none.
      ...(searching ? { include: ["web_search_call.action.sources" as const] } : {}),
    });

    let thought = "";
    let refused = false;
    let stopReason = "stop";
    const usage = usageOf(null);
    let contextTokens = 0;
    let status = "";
    let withSummary = summary;
    const setStatus = (next: Parameters<ChatRequest["onStatus"]>[0], detail?: string) => {
      status = next;
      req.onStatus(next, detail);
    };
    const writer = citingWriter((delta) => {
      if (status !== "writing") setStatus("writing");
      req.onText(delta);
    });
    const searches: string[] = [];
    const found: Source[] = [];
    let webSearches = 0;
    // The files its code made ("container_id/file_id"), the sandbox it ran in, and when the reply
    // began by OpenAI's clock (files the sandbox lists from before then are older replies').
    const made: string[] = [];
    let container: string | null = null;
    let began = 0;

    for (let round = 0; ; round++) {
      let stream;
      try {
        stream = await api.responses.create(params(withSummary, round >= MAX_TOOL_ROUNDS), { signal: req.signal });
      } catch (err) {
        if (!withSummary || !summariesRefused(err)) throw err;
        withSummary = false;
        stream = await api.responses.create(params(false, round >= MAX_TOOL_ROUNDS), { signal: req.signal });
      }

      // What goes back next round when the model asks for the app's tools: its words and calls.
      const said: ResponseInputItem[] = [];
      const calls: ToolCall[] = [];
      for await (const event of stream) {
        // Text goes out one event late, so a citation's link can still become its marker.
        if (
          event.type !== "response.output_text.delta" &&
          event.type !== "response.output_text.annotation.added" &&
          event.type !== "response.output_text.done"
        ) writer.flush();
        switch (event.type) {
          case "response.created":
            if (!began) began = event.response.created_at;
            break;
          case "response.output_item.added":
            if (event.item.type === "reasoning") setStatus("thinking");
            else if (event.item.type === "web_search_call") setStatus("searching");
            else if (event.item.type === "code_interpreter_call") {
              container = event.item.container_id || container;
              setStatus("coding");
            }
            break;
          case "response.output_item.done":
            // What a search looked for is known once it's done. Only searches are billed, not
            // opening a page or finding in one.
            if (event.item.type === "web_search_call" && event.item.action?.type === "search") {
              const action = event.item.action;
              webSearches++;
              for (const q of action.queries?.length ? action.queries : action.query ? [action.query] : []) {
                const query = q.trim();
                if (!query || searches.includes(query)) continue;
                searches.push(query);
                setStatus("searching", query);
              }
              for (const page of action.sources ?? []) {
                const url = cleanUrl(page.url);
                if (found.length < MAX_FOUND && !found.some((f) => f.url === url)) found.push({ url, title: "" });
              }
            } else if (event.item.type === "code_interpreter_call") container = event.item.container_id || container;
            else if (event.item.type === "function_call" && own.has(event.item.name)) {
              const item = event.item;
              calls.push({ id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
              said.push({ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments });
            } else if (event.item.type === "message") {
              const words = event.item.content.map((c) => (c.type === "output_text" ? c.text : "")).join("");
              if (words) said.push({ role: "assistant", content: words });
            }
            break;
          case "response.reasoning_summary_part.added":
            // Each part of the summary is a paragraph of its own.
            if (req.showThinking && thought) {
              thought += "\n\n";
              req.onThinking("\n\n");
            }
            break;
          case "response.reasoning_summary_text.delta":
            if (req.showThinking) {
              thought += event.delta;
              req.onThinking(event.delta);
            }
            break;
          case "response.output_text.delta":
            writer.delta(`${event.item_id}:${event.content_index}`, event.delta);
            break;
          case "response.output_text.annotation.added": {
            const a = event.annotation;
            if (a?.type === "url_citation") writer.cite(`${event.item_id}:${event.content_index}`, a.start_index, a.end_index, a.url, a.title);
            else if (a?.type === "container_file_citation" && !made.includes(`${a.container_id}/${a.file_id}`)) {
              made.push(`${a.container_id}/${a.file_id}`);
            }
            break;
          }
          case "response.refusal.delta":
            refused = true;
            break;
          case "response.completed":
          case "response.incomplete": {
            const r = event.response;
            const u = usageOf(r.usage);
            usage.input += u.input;
            usage.output += u.output;
            usage.cacheRead += u.cacheRead;
            usage.cacheWrite += u.cacheWrite;
            contextTokens = (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0);
            const reason = r.incomplete_details?.reason;
            if (reason === "content_filter") refused = true;
            else if (reason === "max_output_tokens") stopReason = "max_tokens";
            break;
          }
          case "response.failed":
            throw streamError(event.response.error?.code, event.response.error?.message);
          case "error":
            throw streamError(event.code, event.message);
        }
      }
      writer.flush();
      if (!calls.length || refused || req.signal.aborted || round > MAX_TOOL_ROUNDS) break;

      // The model asked for the app's tools: run them all, and carry on with their results.
      writer.pause();
      const outcomes = await Promise.all(calls.map((call) => req.runTool(call)));
      input = [
        ...input,
        ...said,
        ...calls.map((call, i): ResponseInputItem => ({
          type: "function_call_output",
          call_id: call.id,
          output: outcomes[i].isError ? `Error: ${outcomes[i].content}` : outcomes[i].content || "(no output)",
        })),
      ];
      // The sandbox it started stays the one its code runs in.
      if (container) tools = tools.map((t) => (t.type === "code_interpreter" ? { ...t, container: container! } : t));
      setStatus("thinking");
    }
    if (webSearches) usage.webSearches = webSearches;

    // Files its code wrote but didn't link to: the sandbox lists them as the model's.
    if (container && !refused) {
      try {
        for await (const f of api.containers.files.list(container, undefined, { signal: req.signal })) {
          const ref = `${container}/${f.id}`;
          if (f.source === "assistant" && f.created_at >= began && !made.includes(ref)) made.push(ref);
        }
      } catch (err) {
        console.error("[openai] couldn't list the sandbox's files:", err);
      }
    }

    // The id asked for, which the catalog knows, rather than a dated alias.
    return {
      text: writer.text,
      thinking: thought,
      content: null,
      model: req.model,
      stopReason: refused ? "content_filter" : stopReason,
      refused,
      usage,
      searches,
      sources: writer.sources,
      found,
      fileIds: refused ? [] : made,
      container: container ? { id: container, expiresAt: new Date(Date.now() + SANDBOX_IDLE_MS).toISOString() } : null,
      contextTokens,
    };
  }

  /** A short answer at the lowest thinking level the model takes. */
  async function complete(req: CompleteRequest): Promise<CompleteResult> {
    const lowest = findModel(options.provider, req.model)?.efforts[0] ?? "low";
    const params: ResponseCreateParamsNonStreaming = {
      model: req.model,
      instructions: req.system,
      input: req.prompt,
      reasoning: { effort: effortOf(lowest) },
      max_output_tokens: 2000,
      store: false,
    };
    const res = await client(req.apiKey, 1).responses.create(params, { signal: req.signal });
    if (res.incomplete_details?.reason === "content_filter") return null;
    if (res.output.some((item) => item.type === "message" && item.content.some((c) => c.type === "refusal"))) return null;
    return { text: res.output_text, model: req.model, usage: usageOf(res.usage) };
  }

  /** Checks the key against the provider's model list (xAI lists other names for a model too). */
  async function verify(apiKey: string, model: string) {
    const ids: string[] = [];
    for await (const m of client(apiKey, 1).models.list()) {
      ids.push(m.id, ...(((m as { aliases?: unknown }).aliases as string[] | undefined) ?? []));
    }
    if (ids.length > 0 && !ids.includes(model)) throw Object.assign(new Error(`This key can't use ${model}`), { status: 404 });
  }

  return { chat, complete, verify };
}
