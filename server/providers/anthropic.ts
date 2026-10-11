import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { t } from "../i18n.ts";
import { findModel, modelLabel } from "./catalog.ts";
import { anthropicClient } from "./clients.ts";
import {
  fileRef,
  imageCaption,
  MAX_TOOL_ROUNDS,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type CompleteRequest,
  type CompleteResult,
  type HistoryTurn,
  type Source,
  type ToolOutcome,
} from "./types.ts";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Rebuilds the conversation for Claude. Earlier Claude replies go back exactly as they came
 * (thinking blocks included), because the newest models tie their reasoning to an unchanged
 * history. Replies from another provider, or cut short, go back as plain text.
 */
function toMessages(history: HistoryTurn[], fileIds: Map<string, string> | undefined, codeTool: boolean): BetaMessageParam[] {
  return history.flatMap((turn): BetaMessageParam[] => {
    if (turn.role === "user") return [{ role: "user", content: userContent(turn, fileIds, codeTool) }];
    // A mid-chat system note (changed instructions), placed after a user message as the API asks.
    if (turn.role === "system") return [{ role: "system", content: turn.text }];
    // A reply that used the app's tools went back and forth: its turns go back as they were.
    if (turn.provider === "anthropic" && isTurns(turn.content)) {
      return turn.content.map((t) => (t.role === "assistant" ? { role: "assistant", content: echoable(t.content) } : t));
    }
    if (turn.provider === "anthropic" && Array.isArray(turn.content) && turn.content.length > 0) {
      return [{ role: "assistant", content: echoable(turn.content as BetaContentBlockParam[]) }];
    }
    return [{ role: "assistant", content: turn.text }];
  });
}

/**
 * How a reply that used the app's own tools is stored: its turns in order, the model's and the tool
 * results between them. A reply without them is stored as its content blocks alone, as before.
 */
type ReplyTurn = { role: "assistant" | "user"; content: BetaContentBlockParam[] };
const isTurns = (content: unknown): content is ReplyTurn[] =>
  Array.isArray(content) && content.length > 0 && typeof (content[0] as { role?: unknown })?.role === "string";

/**
 * A message with its files ahead of its words: images to look at (each after a line naming it),
 * PDFs and text as documents named after the file. In a chat that can run code every file also goes into the sandbox, so code can
 * open it (that's the only way in for files of other kinds). The blocks depend only on the stored
 * message and the chat's fixed tool list, so the message replays the same way every time.
 */
function userContent(turn: HistoryTurn, fileIds: Map<string, string> | undefined, codeTool: boolean): string | BetaContentBlockParam[] {
  const files = turn.attachments ?? [];
  if (!files.length) return turn.text;
  const blocks: BetaContentBlockParam[] = [];
  for (const file of files) {
    const fileId = fileIds?.get(fileRef(file));
    if (!fileId) throw new Error(`${file.name} wasn't uploaded`);
    if (file.kind === "image") blocks.push({ type: "text", text: imageCaption(file) }, { type: "image", source: { type: "file", file_id: fileId } });
    else if (file.kind === "pdf" || file.kind === "text") blocks.push({ type: "document", source: { type: "file", file_id: fileId }, title: file.name });
    if (codeTool) blocks.push({ type: "container_upload", file_id: fileId });
    else if (file.kind === "other") blocks.push({ type: "text", text: `(${file.name} is attached, but it can't be opened in this chat.)` });
  }
  if (turn.text) blocks.push({ type: "text", text: turn.text });
  return blocks;
}

/**
 * After a mid-reply fallback, blocks the declining model produced before the last `fallback`
 * marker (other than text) must not be echoed back.
 */
function echoable(blocks: BetaContentBlockParam[]): BetaContentBlockParam[] {
  const lastFallback = blocks.findLastIndex((b) => b.type === "fallback");
  if (lastFallback === -1) return blocks;
  return blocks.filter((b, i) => i > lastFallback || b.type === "text" || b.type === "fallback");
}

async function chat(req: ChatRequest): Promise<ChatResult> {
  const client = anthropicClient(req.apiKey, 2);
  const supportsFallback = findModel("anthropic", req.model)?.fallbacks ?? false;

  // "off" exists only for models that can stop thinking: Sonnet 5.5 says so with `between_tools`
  // (which takes no other thinking field), Haiku 5.5 with `disabled`. Both leave effort at the
  // model's default, which is at or below `high`, the most either allows with thinking off.
  const thinkingOff = req.effort === "off";
  // With thinking on, ask for summaries when the site shows them: the raw reasoning is never
  // returned, and thinking costs the same either way.
  const thinking: BetaMessageStreamParams["thinking"] = !thinkingOff
    ? req.showThinking
      ? { type: "adaptive", display: "summarized" }
      : undefined
    : req.model === "claude-sonnet-5-5"
      ? { type: "between_tools" }
      : { type: "disabled" };

  const params: BetaMessageStreamParams = {
    model: req.model,
    max_tokens: 64000,
    system: thinkingOff
      ? `${req.system}\n\nDo not include internal or system XML tags in your response.`
      : req.system,
    messages: toMessages(req.history, req.fileIds, req.codeTool),
    ...(thinking ? { thinking } : {}),
    ...(thinkingOff ? {} : { output_config: { effort: req.effort as "low" | "medium" | "high" | "xhigh" | "max" } }),
    // Caches the conversation so far, so long chats re-read history at the cache-read price.
    cache_control: { type: "ephemeral" },
    ...(supportsFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    ...toolParams(req),
    // Carry on in the sandbox this chat's code ran in before, files and all.
    ...(req.codeTool && req.container ? { container: req.container } : {}),
  };

  let text = "";
  let thought = "";
  // The reply's turns so far (when it used the app's tools), and the model's turn being written.
  const turns: ReplyTurn[] = [];
  let content: BetaContentBlock[] = [];
  const own = new Set(req.functions.map((f) => f.name));
  let toolRounds = 0;
  let resumes = 0;
  // After a round of tools, the next words start a new paragraph.
  let gap = false;
  let contextTokens = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 };
  const searches: string[] = [];
  const sources: Source[] = [];
  const found: Source[] = [];
  let message: BetaMessage | null = null;
  const searched = (query: string | null) => {
    if (!query) return;
    searches.push(query);
    req.onStatus("searching", query);
  };

  // A long search turn can pause (stop_reason "pause_turn"); sending it back resumes it, and the
  // pieces make one turn. A turn that ends asking for the app's own tools gets their results and
  // goes on; the last round allowed has to answer without them.
  for (;;) {
    const messages = [...params.messages, ...turns, ...(content.length ? [{ role: "assistant" as const, content: [...content] }] : [])];
    const lastRound = toolRounds >= MAX_TOOL_ROUNDS && own.size > 0;
    const stream = client.beta.messages.stream(
      { ...params, messages, ...(lastRound ? { tool_choice: { type: "none" as const } } : {}) },
      { signal: req.signal },
    );
    // Per content block of this response: its type, a tool call's input so far, a text block's citations.
    const blocks = new Map<number, { type: string; name?: string; json: string; cites: Source[]; seen?: boolean }>();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        const info = { type: block.type, name: "name" in block ? block.name : undefined, json: "", cites: [] as Source[], seen: false };
        blocks.set(event.index, info);
        if (block.type === "server_tool_use") {
          // A search Claude runs from its own filtering code arrives whole, query included; a direct
          // one streams its input. Its filtering code (code execution) is part of searching too.
          if (block.name === "web_search") {
            const query = queryOf(block.input);
            if (query) {
              info.seen = true;
              searched(query);
            }
          } else req.onStatus(req.codeTool ? "coding" : "searching");
        } else if (block.type === "web_search_tool_result") {
          // The pages a search returned, kept for when the reply cites none of them.
          if (Array.isArray(block.content)) {
            for (const r of block.content) {
              if (found.length < MAX_FOUND && !found.some((f) => f.url === r.url)) found.push({ url: r.url, title: r.title ?? "" });
            }
          }
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          req.onStatus("thinking");
          // A later thinking block (after a fallback or a search, say) starts a new paragraph.
          if (block.type === "thinking" && req.showThinking && thought) {
            thought += "\n\n";
            req.onThinking("\n\n");
          }
        } else if (block.type === "text") req.onStatus("writing");
        else if (block.type === "fallback") req.onNotice(t("Continued with {modelLabel}", { modelLabel: modelLabel("anthropic", block.to.model) }));
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          const piece = gap && text && delta.text ? `\n\n${delta.text.trimStart()}` : delta.text;
          if (delta.text) gap = false;
          text += piece;
          req.onText(piece);
        } else if (delta.type === "thinking_delta" && req.showThinking) {
          thought += delta.thinking;
          req.onThinking(delta.thinking);
        } else if (delta.type === "input_json_delta") {
          const b = blocks.get(event.index);
          if (b) b.json += delta.partial_json;
        } else if (delta.type === "citations_delta" && delta.citation.type === "web_search_result_location") {
          blocks.get(event.index)?.cites.push({ url: delta.citation.url, title: delta.citation.title ?? "" });
        }
      } else if (event.type === "content_block_stop") {
        const b = blocks.get(event.index);
        if (b?.type === "server_tool_use" && b.name === "web_search" && !b.seen) {
          searched(parseQuery(b.json));
        } else if (b?.type === "text" && b.cites.length) {
          // Mark the cited passage with its sources' numbers, as Markdown links: "...blue[1](url)".
          const marks = [...new Map(b.cites.map((c) => [c.url, c])).values()].map((c) => {
            let n = sources.findIndex((x) => x.url === c.url) + 1;
            if (!n) n = sources.push(c);
            return `[${n}](${c.url})`;
          });
          text += marks.join("");
          req.onText(marks.join(""));
        }
      }
    }

    message = await stream.finalMessage();
    content.push(...message.content);
    const u = message.usage;
    usage.input += u.input_tokens;
    usage.output += u.output_tokens;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.webSearches += u.server_tool_use?.web_search_requests ?? 0;
    contextTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens;
    if (message.stop_reason === "pause_turn" && resumes++ < MAX_RESUMES) continue;
    const calls = message.stop_reason === "tool_use" ? message.content.filter((b) => b.type === "tool_use" && own.has(b.name)) : [];
    if (!calls.length || toolRounds > MAX_TOOL_ROUNDS) break;
    // Every call of the turn runs, side by side, and all their results go back in one message.
    const results = await Promise.all(
      calls.map(async (b) => {
        const call = b as Extract<BetaContentBlock, { type: "tool_use" }>;
        const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
        const outcome: ToolOutcome = await req.runTool({ id: call.id, name: call.name, input });
        return { type: "tool_result" as const, tool_use_id: call.id, content: outcome.content || "(no output)", ...(outcome.isError ? { is_error: true } : {}) };
      }),
    );
    if (req.signal.aborted) break;
    turns.push({ role: "assistant", content: content as BetaContentBlockParam[] }, { role: "user", content: results });
    content = [];
    toolRounds++;
    gap = true;
    req.onStatus("thinking");
  }
  if (content.length) turns.push({ role: "assistant", content: content as BetaContentBlockParam[] });
  // Everything the model wrote in this reply, across its turns.
  const written = turns.filter((t) => t.role === "assistant").flatMap((t) => t.content) as BetaContentBlock[];

  const refused = message!.stop_reason === "refusal";
  const container = message?.container ? { id: message.container.id, expiresAt: message.container.expires_at } : null;
  return {
    text,
    thinking: thought,
    // One turn is stored as its blocks, as replies always were; several as the list of turns.
    content: refused ? null : turns.length === 1 ? turns[0].content : turns,
    model: message!.model,
    stopReason: message!.stop_reason ?? "end_turn",
    refused,
    usage,
    searches,
    sources,
    found,
    fileIds: refused ? [] : madeFiles(written),
    container,
    contextTokens,
  };
}

/** The ids of the files the reply's code wrote, in order, each once. */
function madeFiles(content: BetaContentBlock[]): string[] {
  const ids: string[] = [];
  for (const block of content) {
    const result =
      block.type === "bash_code_execution_tool_result" || block.type === "code_execution_tool_result" ? block.content : null;
    if (!result || !("content" in result) || !Array.isArray(result.content)) continue;
    for (const out of result.content) if ("file_id" in out && out.file_id && !ids.includes(out.file_id)) ids.push(out.file_id);
  }
  return ids;
}

/** Pages kept from search results, for a reply that cites none. */
const MAX_FOUND = 10;
/** How many times a paused search turn is resumed before the reply is kept as it stands. */
const MAX_RESUMES = 3;
/** Searches allowed in one reply. Part of the tool's definition, so it never changes. */
const MAX_SEARCHES = 5;

/**
 * The web search tool, when this chat declares it. It is the same definition for every Claude
 * model: a model reads earlier turns' reasoning from other models too, and that reasoning is
 * checked against the exact tool list it was made with, so a per-model version would break a chat
 * that switches models (a 400). The basic version runs on every model and cites its sources; the
 * newer one filters results in code and, in testing, cited none.
 */
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES } as const;
/** Code execution: Claude runs Python and shell in Anthropic's sandbox and can write files. */
const CODE_TOOL = { type: "code_execution_20260120", name: "code_execution" } as const;

/**
 * The tools this chat declares, always in the same order and form, so the list its reasoning is
 * tied to never changes. Each key's switches only decide whether they may be used now: when none
 * of the declared tools may, tool_choice "none"; when only some may, a note on the message says
 * which are off (see chat-store).
 */
function toolParams(req: ChatRequest): Pick<BetaMessageStreamParams, "tools" | "tool_choice"> {
  const tools: NonNullable<BetaMessageStreamParams["tools"]> = [
    ...(req.searchTool ? [WEB_SEARCH_TOOL] : []),
    ...(req.codeTool ? [CODE_TOOL] : []),
    // The app's own tools, as the chat declared them when it started.
    ...req.functions.map((f) => ({ name: f.name, description: f.description, input_schema: f.parameters as { type: "object" } })),
  ];
  if (!tools.length) return {};
  const usable = (req.searchTool && req.searchAllowed) || (req.codeTool && req.codeAllowed) || req.functions.length > 0;
  return { tools, ...(usable ? {} : { tool_choice: { type: "none" as const } }) };
}

function queryOf(input: unknown): string | null {
  const query = (input as { query?: unknown } | null)?.query;
  return typeof query === "string" && query.trim() ? query.trim() : null;
}

function parseQuery(json: string): string | null {
  try {
    return queryOf(JSON.parse(json));
  } catch {
    return null;
  }
}

/** A short answer at the lowest thinking level every Claude model accepts. */
async function complete(req: CompleteRequest): Promise<CompleteResult> {
  const client = anthropicClient(req.apiKey, 1);
  const message = await client.messages.create(
    {
      model: req.model,
      max_tokens: 2000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: "low" },
    },
    { signal: req.signal },
  );
  if (message.stop_reason === "refusal") return null;
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return {
    text,
    model: message.model,
    usage: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

async function verify(apiKey: string, model: string) {
  const client = anthropicClient(apiKey, 1);
  await client.models.retrieve(model);
}

export const anthropicProvider: ChatProvider = { chat, complete, verify };
