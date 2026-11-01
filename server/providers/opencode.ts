// OpenCode's pay-as-you-go API (its Console, once called Zen): one key for Claude, GPT, Gemini, Grok
// and open models. Every one of them answers in OpenAI's chat format, which Console translates for
// the models whose own API is another. Its Go plan is left out: that's for coding agents' traffic.
import { findModel } from "./catalog.ts";
import { compatProvider, type Dialect } from "./compat.ts";

/**
 * The open models it serves in this format, with their reasoning as reasoning_content. Like
 * DeepSeek's own API they want a tool-calling turn's reasoning back, which OpenCode's own client
 * sends; Claude, GPT, Gemini and Grok come through a translation and get the turn without it.
 */
const OWN_FORMAT = new Set(["kimi-k3", "glm-5.3", "deepseek-v4-pro", "deepseek-v4.1-flash", "minimax-m3"]);

/** The request field for a thinking level: OpenCode calls "off" none, and "default" sends nothing. */
const effortOf = (effort: string) => (effort === "default" ? {} : { reasoning_effort: effort === "off" ? "none" : effort });

/** How OpenCode is set up, at its own address (tests reuse it at a mock's). */
export const opencodeDialect = {
  baseURL: "https://opencode.ai/inference/openai/v1",
  // It lists models a level up from where it chats, and only for a good key.
  modelsBaseURL: "https://opencode.ai/inference/v1",
  thinking: (effort) => effortOf(effort),
  quick: (model) => effortOf(findModel("opencode", model)?.efforts[0] ?? "default"),
  // A chat's requests keep to one route by this, so its prompt cache is found again.
  headers: (req): Record<string, string> => (req.cacheKey ? { "x-opencode-session": req.cacheKey } : {}),
  // Gemini, Qwen and MiniMax take a system message only at the start.
  systemMidChat: false,
  thinkTags: true,
  echoReasoning: (model) => OWN_FORMAT.has(model),
} satisfies Dialect;

export const opencodeProvider = compatProvider(opencodeDialect);
