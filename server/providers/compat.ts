// The OpenAI chat-completions format, which DeepSeek, Gemini, Grok and many other services speak at
// their own addresses. Each service is a dialect: where it is, how its thinking is set, and what it
// opens of the files people attach. The conversation goes back as plain text every time: without
// tools, earlier reasoning doesn't need to go back.
import { existsSync, readFileSync } from "node:fs";
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { t } from "../i18n.ts";
import type { FileKind, Usage } from "./catalog.ts";
import { openaiClient } from "./clients.ts";
import { parseArguments } from "./responses.ts";
import {
  imageCaption,
  MAX_TOOL_ROUNDS,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type CompleteRequest,
  type CompleteResult,
  type HistoryAttachment,
  type HistoryTurn,
  type ToolCall,
} from "./types.ts";

export type Dialect = {
  /** The service's address; null when each key brings its own (an admin's own endpoint). */
  baseURL: string | null;
  /** The request fields that set a thinking level, and ask for the reasoning when it's shown. */
  thinking: (effort: string, model: string, show: boolean) => Record<string, unknown>;
  /** The fields for a short one-off answer (a chat's title): as little thinking as the model allows. */
  quick: (model: string) => Record<string, unknown>;
  /** The longest reply asked for; left out where the service picks (its limits vary by model). */
  maxTokens?: number;
  /** How a PDF goes in, where the service reads them. Images always go as data URLs. */
  pdf?: (file: HistoryAttachment, base64: string) => ChatCompletionContentPart;
  /** Whether system notes may sit mid-conversation. Where not, a note joins the message it follows. */
  systemMidChat: boolean;
  /** Whether a reply may open with its reasoning in <think> or <thought> tags (open models, Gemini). */
  thinkTags?: boolean;
  /** Whether a turn that calls tools goes back with its reasoning_content (DeepSeek asks for it). */
  echoReasoning?: boolean;
};

/**
 * Deltas as these services send them, beyond the OpenAI fields: reasoning as its own field (DeepSeek,
 * Qwen, Kimi and GLM call it reasoning_content; OpenRouter, Groq and Ollama reasoning), a flag on
 * Gemini's thought text, and Mistral's content as a list of thinking and text chunks.
 */
type ContentChunk = { type?: string; text?: string; thinking?: string | { text?: string }[] };
type Delta = Omit<ChatCompletionChunk.Choice.Delta, "content"> & {
  content?: string | ContentChunk[] | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  extra_content?: { google?: { thought?: boolean } };
};
type ServiceUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  /** DeepSeek's own names for cache hits and misses. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

function clientFor(dialect: Dialect, apiKey: string, baseUrl: string | undefined, maxRetries: number) {
  const baseURL = dialect.baseURL ?? baseUrl;
  if (!baseURL) throw new Error(t("This key has no address to send to"));
  // A local service may need no key, but the SDK wants one.
  return openaiClient(apiKey || "none", baseURL, maxRetries);
}

/**
 * Cache hits come in under different names; what's left of the prompt is ordinary input. Some
 * services (Gemini, xAI) leave the reasoning out of completion_tokens but count it in the total, so
 * whichever is larger is what the model wrote.
 */
function usageOf(u: ServiceUsage): Usage {
  const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: u.prompt_cache_miss_tokens ?? Math.max(0, u.prompt_tokens - cacheRead),
    output: Math.max(u.completion_tokens, (u.total_tokens ?? 0) - u.prompt_tokens),
    cacheRead,
    cacheWrite: 0,
  };
}

/** A file's name as it's quoted in a message. */
const quoted = (file: HistoryAttachment) => file.name.replace(/"/g, "'");

/** A text file, wrapped in a <file> tag with its name. */
export function fileText(file: HistoryAttachment): string {
  return `<file name="${quoted(file)}">\n${readFileSync(file.path, "utf8").replace(/^﻿/, "")}\n</file>`;
}

/** What a model is told about a file it can't open, or one whose bytes are gone. */
export function fileNote(file: HistoryAttachment, kept: boolean): string {
  return kept
    ? `(The person attached ${quoted(file)}, which this model can't open.)`
    : `(The person attached ${quoted(file)}, which is no longer available.)`;
}

/** A file's bytes as base64, or null when they're gone. */
export function base64Of(file: HistoryAttachment): string | null {
  return existsSync(file.path) ? readFileSync(file.path).toString("base64") : null;
}

/**
 * A message with its files ahead of its words: text files inline, images (and PDFs where the
 * service reads them) as parts of their own, and anything else named but not shown. Only the text
 * of a message with no pictures goes as a plain string, which every service takes.
 */
function userContent(turn: HistoryTurn, reads: FileKind[], dialect: Dialect): string | ChatCompletionContentPart[] {
  const files = turn.attachments ?? [];
  const parts: ChatCompletionContentPart[] = [];
  const text: string[] = [];
  for (const file of files) {
    const opens = file.kind !== "other" && reads.includes(file.kind) && (file.kind !== "pdf" || !!dialect.pdf);
    if (!opens) {
      text.push(fileNote(file, true));
      continue;
    }
    if (file.kind === "text") {
      text.push(existsSync(file.path) ? fileText(file) : fileNote(file, false));
      continue;
    }
    const data = base64Of(file);
    if (!data) text.push(fileNote(file, false));
    else if (file.kind === "image") parts.push({ type: "text", text: imageCaption(file) }, { type: "image_url", image_url: { url: `data:${file.mime};base64,${data}` } });
    else parts.push(dialect.pdf!(file, data));
  }
  const words = [...text, turn.text].filter(Boolean).join("\n\n");
  if (!parts.length) return words;
  return words ? [...parts, { type: "text", text: words }] : parts;
}

function toMessages(req: ChatRequest, dialect: Dialect): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: req.system }];
  for (const turn of req.history) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: userContent(turn, req.reads, dialect) });
    } else if (turn.role === "assistant") {
      messages.push({ role: "assistant", content: turn.text });
    } else if (dialect.systemMidChat) {
      // Mid-chat notes (changed instructions, search off) go in as system messages where they happened.
      messages.push({ role: "system", content: turn.text });
    } else {
      // Some services take a system message only first: the note rides on the message it follows.
      const last = messages[messages.length - 1];
      const note = `<system_note>\n${turn.text}\n</system_note>`;
      if (last?.role !== "user") messages.push({ role: "user", content: note });
      else if (typeof last.content === "string") last.content = [last.content, note].filter(Boolean).join("\n\n");
      else last.content = [...(last.content ?? []), { type: "text", text: note }];
    }
  }
  return messages;
}

/**
 * Splits reasoning a reply opens with in <think> (or Gemini's <thought>) tags from the answer, as
 * the text streams in pieces that can cut a tag in two.
 */
function thinkSplitter(onThinking: (s: string) => void, onText: (s: string) => void) {
  const TAGS = ["think", "thought"];
  let state: "start" | "inside" | "after" = "start";
  let held = "";
  let close = "";
  const push = (piece: string) => {
    if (state === "after") return onText(piece);
    held += piece;
    if (state === "start") {
      const lead = held.trimStart();
      const tag = TAGS.find((t) => lead.startsWith(`<${t}>`));
      if (!tag) {
        if (TAGS.some((t) => `<${t}>`.startsWith(lead))) return;
        state = "after";
        const out = held;
        held = "";
        return onText(out);
      }
      state = "inside";
      close = `</${tag}>`;
      held = lead.slice(tag.length + 2);
    }
    const end = held.indexOf(close);
    if (end !== -1) {
      if (end) onThinking(held.slice(0, end));
      const rest = held.slice(end + close.length).trimStart();
      state = "after";
      held = "";
      if (rest) onText(rest);
      return;
    }
    // Hold back what could be the start of the closing tag.
    const keep = Math.min(held.length, close.length - 1);
    const out = held.slice(0, held.length - keep);
    held = held.slice(held.length - keep);
    if (out) onThinking(out);
  };
  const end = () => {
    if (!held) return;
    if (state === "inside") onThinking(held);
    else onText(held);
    held = "";
  };
  return { push, end };
}

/** A tool call as it streams in: its id and name come first, its arguments in pieces after. */
type StreamedCall = { id: string; type: "function"; function: { name: string; arguments: string }; [extra: string]: unknown };
type ToolCallPiece = { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string }; [extra: string]: unknown };

/**
 * Adds a piece of a streamed tool call to the call it belongs to. Fields a service adds of its own
 * (Gemini's thought signature in extra_content) are kept, since some must go back with the call.
 */
function addCallPiece(calls: Map<number, StreamedCall>, piece: ToolCallPiece) {
  const index = piece.index ?? calls.size;
  const call = calls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
  const { index: _index, id, type: _type, function: fn, ...extra } = piece;
  if (id) call.id = id;
  if (fn?.name) call.function.name = fn.name;
  if (fn?.arguments) call.function.arguments += fn.arguments;
  Object.assign(call, extra);
  calls.set(index, call);
}

/** A request turned down because the model or service doesn't take tools. */
function toolsRefused(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return (status === 400 || status === 404 || status === 422) && /tool|function/i.test((err as Error).message ?? "");
}

/** Removes reasoning in <think> or <thought> tags from a whole answer. */
const withoutThinking = (text: string) => text.replace(/^\s*<(think|thought)>[\s\S]*?<\/\1>\s*/, "");

export function compatProvider(dialect: Dialect): ChatProvider {
  async function chat(req: ChatRequest): Promise<ChatResult> {
    const client = clientFor(dialect, req.apiKey, req.baseUrl, 2);
    const messages = toMessages(req, dialect);
    // The app's tools as functions. A service (or a local model) that can't take them gets the
    // request again without, and answers from what it knows.
    let tools = req.functions.length
      ? req.functions.map((f) => ({ type: "function" as const, function: { name: f.name, description: f.description, parameters: f.parameters } }))
      : null;
    // Only these run, whatever name the model sends back.
    const own = new Set(req.functions.map((f) => f.name));
    const params = (lastRound: boolean) =>
      ({
        model: req.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(dialect.maxTokens ? { max_tokens: dialect.maxTokens } : {}),
        ...dialect.thinking(req.effort, req.model, req.showThinking),
        ...(tools ? { tools, ...(lastRound ? { tool_choice: "none" } : {}) } : {}),
      }) as ChatCompletionCreateParamsStreaming;

    let text = "";
    let thought = "";
    let stopReason = "stop";
    let refused = false;
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let contextTokens = 0;
    let status: "thinking" | "writing" | null = null;
    /** A round of tools just ended: the next words start a new paragraph. */
    let gap = false;

    for (let round = 0; ; round++) {
      let stream;
      try {
        stream = await client.chat.completions.create(params(round >= MAX_TOOL_ROUNDS), { signal: req.signal });
      } catch (err) {
        if (!tools || round > 0 || !toolsRefused(err)) throw err;
        console.error(`[chat] ${req.model} took no tools, asking without them:`, (err as Error).message);
        tools = null;
        stream = await client.chat.completions.create(params(false), { signal: req.signal });
      }

      // This round's words, reasoning and calls (the calls arrive in pieces, by index).
      let said = "";
      let reasoned = "";
      const calls = new Map<number, StreamedCall>();
      const thinking = (piece: string) => {
        if (!piece) return;
        reasoned += piece;
        if (status !== "thinking" && !said) {
          status = "thinking";
          req.onStatus("thinking");
        }
        if (req.showThinking) {
          // A new round's reasoning starts a new paragraph.
          const p = thought && reasoned === piece ? `\n\n${piece}` : piece;
          thought += p;
          req.onThinking(p);
        }
      };
      const writing = (piece: string) => {
        if (!piece) return;
        if (status !== "writing") {
          status = "writing";
          req.onStatus("writing");
        }
        said += piece;
        const out = gap && text ? `\n\n${piece.trimStart()}` : piece;
        if (gap && piece.trim()) gap = false;
        text += out;
        req.onText(out);
      };
      const split = dialect.thinkTags ? thinkSplitter(thinking, writing) : null;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta as Delta | undefined;
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === "string") thinking(reasoning);
        const content = delta?.content;
        if (typeof content === "string" && content) {
          if (delta?.extra_content?.google?.thought) thinking(content);
          else if (split) split.push(content);
          else writing(content);
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "thinking") {
              thinking(typeof part.thinking === "string" ? part.thinking : (part.thinking ?? []).map((t) => t.text ?? "").join(""));
            } else if (part.text) writing(part.text);
          }
        }
        for (const piece of delta?.tool_calls ?? []) addCallPiece(calls, piece as ToolCallPiece);
        if (delta?.refusal) refused = true;
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        if (chunk.usage) {
          const u = usageOf(chunk.usage as ServiceUsage);
          usage.input += u.input;
          usage.output += u.output;
          usage.cacheRead += u.cacheRead;
          contextTokens = (chunk.usage as ServiceUsage).prompt_tokens + u.output;
        }
      }
      split?.end();

      const asked = [...calls.values()].filter((c) => own.has(c.function.name));
      if (!asked.length || refused || req.signal.aborted || round > MAX_TOOL_ROUNDS || !tools) break;

      // The model asked for tools: its turn goes back with the calls (Gemini's thought signatures
      // ride along on them, DeepSeek's reasoning beside them), then a result for each.
      asked.forEach((c, i) => (c.id ||= `call_${round}_${i}`));
      const toolCalls: ToolCall[] = asked.map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));
      const outcomes = await Promise.all(toolCalls.map((call) => req.runTool(call)));
      messages.push({
        role: "assistant",
        content: said || null,
        tool_calls: asked,
        ...(reasoned && dialect.echoReasoning ? { reasoning_content: reasoned } : {}),
      } as ChatCompletionMessageParam);
      toolCalls.forEach((call, i) =>
        messages.push({ role: "tool", tool_call_id: call.id, content: outcomes[i].isError ? `Error: ${outcomes[i].content}` : outcomes[i].content || "(no output)" }),
      );
      stopReason = "stop";
      gap = true;
      status = null;
    }

    refused ||= stopReason === "content_filter";
    if (stopReason === "tool_calls") stopReason = "stop";
    // The id asked for, which the catalog knows, rather than a dated alias some services report.
    return { text, thinking: thought, content: null, model: req.model, stopReason, refused, usage, searches: [], sources: [], found: [], fileIds: [], container: null, contextTokens };
  }

  async function complete(req: CompleteRequest): Promise<CompleteResult> {
    const client = clientFor(dialect, req.apiKey, req.baseUrl, 1);
    const params = {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      // Room for a little reasoning where it can't be turned off.
      max_tokens: 1000,
      ...dialect.quick(req.model),
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    const res = await client.chat.completions.create(params, { signal: req.signal });
    const choice = res.choices[0];
    if (!choice || choice.finish_reason === "content_filter" || choice.message.refusal) return null;
    return {
      text: withoutThinking(choice.message.content ?? ""),
      model: req.model,
      usage: res.usage ? usageOf(res.usage as ServiceUsage) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  /** Checks the key against the service's model list. A service without one gets a one-word question. */
  async function verify(apiKey: string, model: string, baseUrl?: string) {
    const client = clientFor(dialect, apiKey, baseUrl, 1);
    let ids: string[];
    try {
      ids = [];
      for await (const m of client.models.list()) ids.push(m.id.replace(/^models\//, ""));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (dialect.baseURL || (status !== 404 && status !== 405)) throw err;
      await client.chat.completions.create({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 16 });
      return;
    }
    if (ids.length > 0 && !ids.includes(model)) {
      const shown = ids.length > 12 ? t("{ids} and {length} more", { ids: ids.slice(0, 12).join(", "), length: ids.length - 12 }) : ids.join(", ");
      throw new Error(t("This key can't use {model}. It offers {shown}", { model, shown }));
    }
  }

  return { chat, complete, verify };
}
