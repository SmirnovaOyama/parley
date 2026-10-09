import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { ChatProvider, ChatRequest, ChatResult, CompleteRequest, CompleteResult } from "./types.ts";

// DeepSeek speaks the OpenAI chat-completions format at its own base URL.
const BASE_URL = "https://api.deepseek.com";

type DeepSeekDelta = ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null };
type DeepSeekUsage = { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };

async function chat(req: ChatRequest): Promise<ChatResult> {
  const client = new OpenAI({ apiKey: req.apiKey, baseURL: BASE_URL, maxRetries: 2 });

  // Without tools, earlier reasoning doesn't need to go back, so plain text is the whole history.
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: req.system },
    // Mid-chat system notes (changed instructions) go in as system messages where they happened.
    ...req.history.map((t) => ({ role: t.role, content: t.text }) as ChatCompletionMessageParam),
  ];

  // Thinking is on by default at DeepSeek; "off" turns it off, otherwise it sets the effort
  // (low, high or max).
  const thinking =
    req.effort === "off"
      ? { thinking: { type: "disabled" } }
      : { reasoning_effort: req.effort as "low" | "high" | "max" };

  const params = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 32768,
    ...thinking,
  } as ChatCompletionCreateParamsStreaming;

  const stream = await client.chat.completions.create(params, { signal: req.signal });

  let text = "";
  let thought = "";
  let stopReason = "stop";
  let model = req.model;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let status: "thinking" | "writing" | null = null;

  for await (const chunk of stream) {
    model = chunk.model || model;
    const choice = chunk.choices[0];
    const delta = choice?.delta as DeepSeekDelta | undefined;
    if (delta?.reasoning_content) {
      if (status !== "thinking" && !text) {
        status = "thinking";
        req.onStatus("thinking");
      }
      if (req.showThinking) {
        thought += delta.reasoning_content;
        req.onThinking(delta.reasoning_content);
      }
    }
    if (delta?.content) {
      if (status !== "writing") {
        status = "writing";
        req.onStatus("writing");
      }
      text += delta.content;
      req.onText(delta.content);
    }
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    if (chunk.usage) {
      const u = chunk.usage as typeof chunk.usage & DeepSeekUsage;
      usage.cacheRead = u.prompt_cache_hit_tokens ?? 0;
      usage.input = u.prompt_cache_miss_tokens ?? u.prompt_tokens - usage.cacheRead;
      usage.output = u.completion_tokens;
    }
  }

  const refused = stopReason === "content_filter";
  return { text, thinking: thought, content: null, model, stopReason, refused, usage, searches: [], sources: [], found: [], fileIds: [], container: null };
}

/** A short answer with thinking off. */
async function complete(req: CompleteRequest): Promise<CompleteResult> {
  const client = new OpenAI({ apiKey: req.apiKey, baseURL: BASE_URL, maxRetries: 1 });
  const params = {
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.prompt },
    ],
    max_tokens: 100,
    thinking: { type: "disabled" },
  } as unknown as ChatCompletionCreateParamsNonStreaming;
  const res = await client.chat.completions.create(params, { signal: req.signal });
  const choice = res.choices[0];
  if (!choice || choice.finish_reason === "content_filter") return null;
  const u = res.usage as (typeof res.usage & DeepSeekUsage) | undefined;
  const cacheRead = u?.prompt_cache_hit_tokens ?? 0;
  return {
    text: choice.message.content ?? "",
    model: res.model,
    usage: {
      input: u ? (u.prompt_cache_miss_tokens ?? u.prompt_tokens - cacheRead) : 0,
      output: u?.completion_tokens ?? 0,
      cacheRead,
      cacheWrite: 0,
    },
  };
}

async function verify(apiKey: string, model: string) {
  const client = new OpenAI({ apiKey, baseURL: BASE_URL, maxRetries: 1 });
  const list = await client.models.list();
  const ids = list.data.map((m) => m.id);
  if (ids.length > 0 && !ids.includes(model)) {
    throw new Error(`This key can't use ${model}. Available: ${ids.join(", ")}`);
  }
}

export const deepseekProvider: ChatProvider = { chat, complete, verify };
