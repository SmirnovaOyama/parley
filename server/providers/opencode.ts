// OpenCode's API (its Console, once called Zen), on either plan: pay-as-you-go, one key for Claude,
// GPT, Gemini, Grok and open models, or Go, a subscription to a smaller set, at an address of its own.
// Every model answers in OpenAI's chat format, which Console translates for the models whose own API
// is another. OpenCode means Go for coding agents and watches its traffic, so a busy site may be noticed.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { findModel } from "./catalog.ts";
import { compatProvider, type Dialect } from "./compat.ts";

/**
 * The open models it serves in this format, with their reasoning as reasoning_content. Like
 * DeepSeek's own API they want a tool-calling turn's reasoning back, which OpenCode's own client
 * sends; Claude, GPT, Gemini and Grok come through a translation and get the turn without it.
 */
const OWN_FORMAT = new Set(["kimi-k3", "glm-5.3", "deepseek-v4-pro", "deepseek-v4.1-flash", "minimax-m3"]);
/** The same on Go, which serves MiniMax M3 and Qwen through Anthropic's format instead. */
const GO_OWN_FORMAT = new Set(["kimi-k3.1-pro", "kimi-k3", "glm-5.3", "glm-5.3-flash", "deepseek-v4-pro", "deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-pro"]);

/** The request field for a thinking level: OpenCode calls "off" none, and "default" sends nothing. */
const effortOf = (effort: string) => (effort === "default" ? {} : { reasoning_effort: effort === "off" ? "none" : effort });

/** Parley's version from package.json, which ships beside the server; without it, the name alone. */
function version(): string {
  try {
    return `/${(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version}`;
  } catch {
    return "";
  }
}

/** How OpenCode is set up, at its own address (tests reuse it at a mock's). */
export const opencodeDialect = {
  baseURL: "https://opencode.ai/inference/openai/v1",
  // It lists models a level up from where it chats, and only for a good key.
  modelsBaseURL: "https://opencode.ai/inference/v1",
  // OpenCode asks a client to say who it is, rather than which SDK it uses.
  userAgent: `Parley${version()}`,
  thinking: (effort) => effortOf(effort),
  quick: (model) => effortOf(findModel("opencode", model)?.efforts[0] ?? "default"),
  // A chat's requests keep to one route by this, so its prompt cache is found again.
  headers: (req): Record<string, string> => (req.cacheKey ? { "x-opencode-session": req.cacheKey } : {}),
  // Gemini, Qwen and MiniMax take a system message only at the start.
  systemMidChat: false,
  thinkTags: true,
  echoReasoning: (model) => OWN_FORMAT.has(model),
} satisfies Dialect;

/** Its Go plan: the same API at Go's own address, with Go's models (tests reuse it at a mock's). */
export const opencodeGoDialect = {
  ...opencodeDialect,
  baseURL: "https://opencode.ai/inference/go/openai/v1",
  modelsBaseURL: "https://opencode.ai/inference/go/v1",
  quick: (model) => effortOf(findModel("opencode-go", model)?.efforts[0] ?? "default"),
  // Go turns away a request with no session, so one outside a chat gets a session of its own.
  headers: (req): Record<string, string> => ({ "x-opencode-session": req.cacheKey ?? randomUUID() }),
  echoReasoning: (model) => GO_OWN_FORMAT.has(model),
} satisfies Dialect;

export const opencodeProvider = compatProvider(opencodeDialect);
export const opencodeGoProvider = compatProvider(opencodeGoDialect);
